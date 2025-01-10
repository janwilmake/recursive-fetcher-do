# Distributed Fetch Through CloudFlare Durable Objects

> WIP: May still be unstable

`dodFetch` alleviates Cloudflare limits of 1000 max requests and 6 concurrent requests in a worker. It does this using nested durable objects. The API is simple. In the below example, we'll fetch 10000 hackernews items from their API (this will a ±30 seconds; for less it's much faster; speed can likely still be optimised)

```ts
import { RecursiveFetcherEnv, dodFetch, RecursiveFetcherDO } from "dofetch";
export { RecursiveFetcherDO };
interface Env extends RecursiveFetcherEnv {
  SECRET: string;
}

export default {
  fetch: async (request: Request, env: Env) => {
    // Requests can have headers, method, and body too
    const requests = Array.from({ length: 10000 }, (_, i) => ({
      url: `https://hacker-news.firebaseio.com/v0/item/${i + 1}.json`,
    }));

    const responses = await dodFetch({
      env,
      requests,
      // optional: set a ratelimit; higher than this is not recommended
      rps: 5000,
      windowDuration: 1000,
    });

    return new Response(JSON.stringify(responses));
  },
};
```

For `do-store`: There seems to be a bug now that, sometimes, it doesn't process all. With https://recursive-fetcher-do.githuq.workers.dev/?secret=******&max=1050 it randomly shows 200: 1050 or 200:1000. Strange cap!

I've chosen to store the results in the same DO as they are fetched, because this will allow for the highest possible ratelimit. May be changed in the future.

Notes: Depending on your desired concurrency, in development this is very slow with large sets of requests, but in prod it's faster.
