import { DurableObject } from "cloudflare:workers";

// Configuration constants
const BRANCHES_PER_LAYER = 10;
const INITIAL_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 5000;
const MAX_RETRIES = 10;
const JITTER_MAX_MS = 50;

interface RequestType {
  url: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  index: number;
}

export interface RecursiveFetcherEnv {
  RECURSIVE_FETCHER: DurableObjectNamespace;
}

interface FetcherConfig {
  requests: RequestType[];
  fetchesPerDO: number;
  rateLimit: {
    requestsPerSecond: number;
    windowDuration: number;
  };
}

interface FetcherResult {
  results: Record<string, number>;
  duration: number;
}

export function createFetcher(context: {
  env: RecursiveFetcherEnv;
  requests: Omit<RequestType, "index">[];
  /** Amount of requests per window duration. Recommended to be 5000 or lower. Defaults to 1000 */
  rps?: number;
  /** Defaults to 1000ms */
  windowDuration?: number;
  // /** Defaults to 6. For many lightweight fetches such as scraping static files, more is recommended, while for LLM calls, a single one is often fastest. */
  // fetchesPerDO?: number;
}) {
  const { env, requests } = context;
  const rps = context.rps || 1000;
  const fetchesPerDO = 1; //context.fetchesPerDO || 6;
  const windowDuration = context.windowDuration || 1000;
  // Calculate chunks based on rate limiting
  const requestsPerWindow = Math.floor((rps * windowDuration) / 1000);
  const indexedRequests: RequestType[] = requests.map((r, i) => ({
    ...r,
    index: i,
  }));
  const chunks: RequestType[][] = [];

  for (let i = 0; i < requests.length; i += requestsPerWindow) {
    chunks.push(indexedRequests.slice(i, i + requestsPerWindow));
  }

  const resultDoIdNames: number[] = [];
  for (let i = 0; i < requests.length; i += fetchesPerDO) {
    resultDoIdNames.push(i);
  }

  console.log({ chunks, resultDoIdNames });

  const results: Record<string, number> = {};
  const promises: Promise<void>[] = [];
  let startTime: number;

  const processChunks = async () => {
    startTime = Date.now();

    // Process chunks with time windows
    for (let i = 0; i < chunks.length; i++) {
      const promise = (async () => {
        const chunk = chunks[i];
        try {
          // Use the first index in the chunk as the DO ID if this chunk is small enough
          const id =
            chunk.length <= fetchesPerDO
              ? env.RECURSIVE_FETCHER.idFromName(String(chunk[0].index))
              : env.RECURSIVE_FETCHER.newUniqueId();

          const recursiveFetcher = env.RECURSIVE_FETCHER.get(id);
          const config: FetcherConfig = {
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

          const chunkResults: Record<string, number> = await response.json();
          for (const [status, count] of Object.entries(chunkResults)) {
            results[status] = (results[status] || 0) + (count as number);
          }
        } catch (error) {
          console.error("Error in worker:", error);
          results["500"] = (results["500"] || 0) + chunk.length;
        }
      })();
      promises.push(promise);

      if (requestsPerWindow > 0 && i < chunks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, windowDuration));
      }
    }
  };

  const withResponse = (index: number) => {
    const nextIndex = resultDoIdNames.findIndex((i) => i > index);
    const i =
      resultDoIdNames[nextIndex - 1] !== undefined
        ? resultDoIdNames[nextIndex - 1]
        : resultDoIdNames[resultDoIdNames.length - 1];
    console.log(`for ${index} we need ${i}`, { index, i, nextIndex });

    const id = env.RECURSIVE_FETCHER.idFromName(String(i));
    const do_ = env.RECURSIVE_FETCHER.get(id);
    return do_.fetch(
      new Request(`http://internal/?index=${index}`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  // Start processing immediately
  processChunks();

  const waitForResult = async (): Promise<FetcherResult> => {
    console.log({ promises });
    await Promise.all(promises);
    const duration = Date.now() - startTime;
    return { results, duration };
  };

  return { withResponse, waitForResult };
}

// Enhanced DO implementation with SQLite storage
export class RecursiveFetcherDO extends DurableObject {
  private db: SqlStorage;
  private activeRequests: number = 0;

  constructor(
    readonly state: DurableObjectState,
    readonly env: RecursiveFetcherEnv,
  ) {
    super(state, env);
    this.db = this.state.storage.sql;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS responses (
        request_index INTEGER PRIMARY KEY,
        url TEXT NOT NULL,
        method TEXT,
        request_headers TEXT,
        request_body TEXT,
        response_status INTEGER,
        response_headers TEXT,
        response_body TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === "GET") {
      return await this.handleGet(request);
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      const config: FetcherConfig = await request.json();
      const { requests, fetchesPerDO } = config;

      if (requests.length === 0) {
        return new Response(JSON.stringify({}), {
          headers: { "Content-Type": "application/json" },
        });
      }

      console.log("need to handle do: ", requests.length, fetchesPerDO);
      this.activeRequests++;

      try {
        if (requests.length <= fetchesPerDO) {
          return await this.handleRequests(requests);
        }
        return await this.handleMultipleRequests(requests, fetchesPerDO);
      } finally {
        this.activeRequests--;
      }
    } catch (error) {
      console.error("Error in DO:", error);
      return new Response(JSON.stringify({ "500": 1 }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async handleGet(request: Request): Promise<Response> {
    const tryParseJson = (string: string) => {
      try {
        return JSON.parse(string);
      } catch (e) {
        return string;
      }
    };
    const index = new URL(request.url).searchParams.get("index");
    console.log("looking up ", index, "in", this.state.id.toString());
    const result = this.db
      .exec("SELECT * FROM responses WHERE request_index = ?", index)
      .toArray()
      .map((item) => ({
        ...item,
        request_headers: item.request_headers
          ? JSON.parse(item.request_headers as string)
          : undefined,
        response_headers: item.response_headers
          ? JSON.parse(item.response_headers as string)
          : undefined,
        response_body: item.response_body
          ? tryParseJson(item.response_body as string)
          : undefined,
      }));

    if (result.length === 0) {
      return new Response("Response not found", { status: 404 });
    }

    return new Response(JSON.stringify(result[0]), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleRequests(requests: RequestType[]): Promise<Response> {
    const results: Record<string, number> = {};

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
          const responseHeaders: { [key: string]: string } = {};
          response.headers.forEach(
            (value, key) => (responseHeaders[key] = value),
          );

          console.log("storing", request, this.state.id.toString());
          // Store response in SQLite
          this.db.exec(
            `
            INSERT OR REPLACE INTO responses 
            (request_index, url, method, request_headers, request_body, 
             response_status, response_headers, response_body)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
            request.index,
            request.url,
            request.method || "GET",
            JSON.stringify(request.headers),
            request.body || "",
            response.status,
            JSON.stringify(responseHeaders),
            responseBody,
          );

          if (response.status === 429 || response.status === 503) {
            throw new Error(`Rate limited: ${response.status}`);
          }

          const resultText =
            response.status === 200
              ? "200"
              : `${response.status}:${responseBody}`;
          results[resultText] = (results[resultText] || 0) + 1;
          break;
        } catch (error) {
          retries++;
          if (retries === MAX_RETRIES) {
            results["Error Fetching URL"] =
              (results["Error Fetching URL"] || 0) + 1;
            break;
          }

          const jitter = Math.random() * JITTER_MAX_MS;
          delay = Math.min(delay * 2, MAX_BACKOFF_MS) + jitter;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    return new Response(JSON.stringify(results), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleMultipleRequests(
    requests: RequestType[],
    fetchesPerDO: number,
  ): Promise<Response> {
    const chunkSize = Math.ceil(
      requests.length / Math.min(BRANCHES_PER_LAYER, requests.length),
    );
    const chunks: RequestType[][] = [];
    console.log({ chunkSize });
    for (let i = 0; i < requests.length; i += chunkSize) {
      chunks.push(requests.slice(i, i + chunkSize));
    }

    const processSingleChunk = async (chunk: RequestType[]) => {
      let retries = 0;
      let delay = INITIAL_BACKOFF_MS;

      while (retries < MAX_RETRIES) {
        try {
          // Use first request's index as DO ID if chunk is small enough
          const id =
            chunk.length <= fetchesPerDO
              ? this.env.RECURSIVE_FETCHER.idFromName(String(chunk[0].index))
              : this.env.RECURSIVE_FETCHER.newUniqueId();
          console.log(
            "chunk length",
            chunk.length,
            "id becomes:",
            id.toString(),
          );

          const fetcher = this.env.RECURSIVE_FETCHER.get(id);

          const config: Omit<FetcherConfig, "rateLimit"> = {
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

          return (await response.json()) as Record<string, number>;
        } catch (e: any) {
          retries++;
          if (retries === MAX_RETRIES) {
            return {
              [`500 - Failed to fetch self - ${e.message}`]: chunk.length,
            };
          }

          const jitter = Math.random() * JITTER_MAX_MS;
          delay = Math.min(delay * 2, MAX_BACKOFF_MS) + jitter;

          if (this.activeRequests > BRANCHES_PER_LAYER * 2) {
            delay *= 1.5;
          }

          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }

      return { "Max Retries Exceeded": chunk.length };
    };

    try {
      const results = await Promise.all(chunks.map(processSingleChunk));
      const finalCounts: Record<string, number> = {};

      for (const result of results) {
        for (const [status, count] of Object.entries(result)) {
          finalCounts[status] = (finalCounts[status] || 0) + count;
        }
      }

      return new Response(JSON.stringify(finalCounts), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("Error processing chunks:", error);
      return new Response(
        JSON.stringify({ "Catch in handling multiple URLs": requests.length }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }
}
