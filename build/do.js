import { DurableObject } from "cloudflare:workers";
// Configuration constants
const BRANCHES_PER_LAYER = 10;
const INITIAL_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 5000;
const MAX_RETRIES = 10;
const JITTER_MAX_MS = 50;
export async function dodFetch(context) {
    const { env, requests } = context;
    const rps = context.rps || 1000;
    const fetchesPerDO = 1;
    const windowDuration = context.windowDuration || 1000;
    if (!env.RECURSIVE_FETCHER) {
        throw new Error(`Please ensure to add the DO to your wrangler.toml, as such:
      
      
\`\`\`toml
[durable_objects]
bindings = [{ name = "RECURSIVE_FETCHER", class_name = "RecursiveFetcherDO" }]

[[migrations]]
tag = "v1"
new_classes = ["RecursiveFetcherDO"]
\`\`\`

`);
    }
    const indexedRequests = requests.map((r, i) => ({
        ...r,
        index: i,
    }));
    const requestsPerWindow = Math.floor((rps * windowDuration) / 1000);
    const chunks = [];
    for (let i = 0; i < indexedRequests.length; i += requestsPerWindow) {
        chunks.push(indexedRequests.slice(i, i + requestsPerWindow));
    }
    const results = new Array(requests.length);
    try {
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            try {
                const id = chunk.length <= fetchesPerDO
                    ? env.RECURSIVE_FETCHER.idFromName(String(chunk[0].index))
                    : env.RECURSIVE_FETCHER.newUniqueId();
                const recursiveFetcher = env.RECURSIVE_FETCHER.get(id);
                const config = {
                    requests: chunk,
                    fetchesPerDO,
                    rateLimit: {
                        requestsPerSecond: rps,
                        windowDuration,
                    },
                };
                const response = await recursiveFetcher.fetch("http://internal/", {
                    method: "POST",
                    body: JSON.stringify(config),
                });
                if (!response.ok) {
                    throw new Error(`DO returned status ${response.status}`);
                }
                const chunkResponses = await response.json();
                chunkResponses.forEach((resp, idx) => {
                    results[chunk[idx].index] = resp;
                });
            }
            catch (error) {
                for (const req of chunk) {
                    results[req.index] = {
                        status: 500,
                        headers: {},
                        body: `Error processing request: ${error.message}`,
                    };
                }
            }
            if (requestsPerWindow > 0 && i < chunks.length - 1) {
                await new Promise((resolve) => setTimeout(resolve, windowDuration));
            }
        }
        return results.filter((r) => r !== undefined);
    }
    catch (error) {
        return indexedRequests.map(() => ({
            status: 500,
            headers: {},
            body: `Catastrophic error in doFetch: ${error.message}`,
        }));
    }
}
export class RecursiveFetcherDO extends DurableObject {
    state;
    env;
    activeRequests = 0;
    constructor(state, env) {
        super(state, env);
        this.state = state;
        this.env = env;
    }
    async fetch(request) {
        if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
        }
        try {
            const config = await request.json();
            const { requests, fetchesPerDO } = config;
            if (requests.length === 0) {
                return new Response("[]", {
                    headers: { "Content-Type": "application/json" },
                });
            }
            this.activeRequests++;
            try {
                if (requests.length <= fetchesPerDO) {
                    return await this.handleRequests(requests);
                }
                return await this.handleMultipleRequests(requests, fetchesPerDO);
            }
            finally {
                this.activeRequests--;
            }
        }
        catch (error) {
            console.error("Error in DO:", error);
            return new Response(JSON.stringify([]), {
                status: 500,
                headers: { "Content-Type": "application/json" },
            });
        }
    }
    async handleRequests(requests) {
        const responses = [];
        for (const request of requests) {
            let retries = 0;
            let delay = INITIAL_BACKOFF_MS;
            while (retries < MAX_RETRIES) {
                try {
                    const response = await fetch(request.url, {
                        method: request.method || "GET",
                        body: request.body,
                        headers: request.headers,
                    });
                    const responseBody = await response.text();
                    const responseHeaders = {};
                    response.headers.forEach((value, key) => (responseHeaders[key] = value));
                    if (response.status === 429 || response.status === 503) {
                        throw new Error(`Rate limited: ${response.status}`);
                    }
                    responses.push({
                        status: response.status,
                        headers: responseHeaders,
                        body: responseBody,
                    });
                    break;
                }
                catch (error) {
                    retries++;
                    if (retries === MAX_RETRIES) {
                        responses.push({
                            status: 500,
                            headers: {},
                            body: `Error fetching URL: ${error.message}`,
                        });
                        break;
                    }
                    const jitter = Math.random() * JITTER_MAX_MS;
                    delay = Math.min(delay * 2, MAX_BACKOFF_MS) + jitter;
                    await new Promise((resolve) => setTimeout(resolve, delay));
                }
            }
        }
        return new Response(JSON.stringify(responses), {
            headers: { "Content-Type": "application/json" },
        });
    }
    async handleMultipleRequests(requests, fetchesPerDO) {
        const chunkSize = Math.ceil(requests.length / Math.min(BRANCHES_PER_LAYER, requests.length));
        const chunks = [];
        for (let i = 0; i < requests.length; i += chunkSize) {
            chunks.push(requests.slice(i, i + chunkSize));
        }
        const processSingleChunk = async (chunk) => {
            let retries = 0;
            let delay = INITIAL_BACKOFF_MS;
            while (retries < MAX_RETRIES) {
                try {
                    const id = chunk.length <= fetchesPerDO
                        ? this.env.RECURSIVE_FETCHER.idFromName(String(chunk[0].index))
                        : this.env.RECURSIVE_FETCHER.newUniqueId();
                    const fetcher = this.env.RECURSIVE_FETCHER.get(id);
                    const config = {
                        requests: chunk,
                        fetchesPerDO,
                    };
                    const response = await fetcher.fetch("http://internal/", {
                        method: "POST",
                        body: JSON.stringify(config),
                    });
                    if (response.status === 429 || response.status === 503) {
                        throw new Error(`Rate limited: ${response.status}`);
                    }
                    if (!response.ok) {
                        throw new Error(`Other status: ${response.status}`);
                    }
                    return await response.json();
                }
                catch (e) {
                    retries++;
                    if (retries === MAX_RETRIES) {
                        return chunk.map(() => ({
                            status: 500,
                            headers: {},
                            body: `Failed to fetch self: ${e.message}`,
                        }));
                    }
                    const jitter = Math.random() * JITTER_MAX_MS;
                    delay = Math.min(delay * 2, MAX_BACKOFF_MS) + jitter;
                    if (this.activeRequests > BRANCHES_PER_LAYER * 2) {
                        delay *= 1.5;
                    }
                    await new Promise((resolve) => setTimeout(resolve, delay));
                }
            }
            return chunk.map(() => ({
                status: 500,
                headers: {},
                body: "Max retries exceeded",
            }));
        };
        try {
            const results = await Promise.all(chunks.map(processSingleChunk));
            const flattenedResults = results.flat();
            return new Response(JSON.stringify(flattenedResults), {
                headers: { "Content-Type": "application/json" },
            });
        }
        catch (error) {
            console.error("Error processing chunks:", error);
            return new Response(JSON.stringify([]), {
                status: 500,
                headers: { "Content-Type": "application/json" },
            });
        }
    }
}
