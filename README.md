# Distributed Fetch Through CloudFlare Durable Objects

> WIP: May still be unstable.

`dodFetch` alleviates Cloudflare limits of 1000 max requests and 6 concurrent requests in a worker. It does this using nested durable objects. The API is simple:

```ts
import { RecursiveFetcherEnv, doFetch, RecursiveFetcherDO } from "dofetch";
export { RecursiveFetcherDO };
interface Env extends RecursiveFetcherEnv {
  SECRET: string;
}

export default {
  fetch: async (request: Request, env: Env) => {
    const responses = await doFetch({
      env,
      requests: [
        { url: "xyz" },
        { url: "xyz", method: "POST" },
        { url: "xyz", headers: { accept: "application/json" } },
      ],
      // optional: set a ratelimit, e.g. 500 per minute
      rps: 500,
      windowDuration: 60000,
    });

    return new Response(JSON.stringify(responses));
  },
};
```

For `do-store`: There seems to be a bug now that, sometimes, it doesn't process all. With https://recursive-fetcher-do.githuq.workers.dev/?secret=******&max=1050 it randomly shows 200: 1050 or 200:1000. Strange cap!

I've chosen to store the results in the same DO as they are fetched, because this will allow for the highest possible ratelimit. May be changed in the future.

Notes: Depending on your desired concurrency, in development this is very slow with large sets of requests, but in prod it's faster.
