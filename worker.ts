import { RecursiveFetcherEnv, createFetcher } from "./do";
export { RecursiveFetcherDO } from "./do";

interface Env extends RecursiveFetcherEnv {
  SECRET: string;
}

// This is an example of how this DO can be used

export default {
  fetch: async (request: Request, env: Env) => {
    const url = new URL(request.url);
    if (url.searchParams.get("secret") !== env.SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    const start = Number(url.searchParams.get("start") || 1);
    const max = Number(url.searchParams.get("max") || 100);

    if (isNaN(start) || isNaN(max)) {
      return new Response("Please provide numbers", { status: 400 });
    }

    const requests = Array.from({ length: max }, (_, i) => ({
      url: `https://hacker-news.firebaseio.com/v0/item/${start + i}.json`,
    }));

    const { waitForResult, withResponse } = createFetcher({
      env,
      requests,
    });

    // we can wait for all and do something with that (in some cases, nothig needs to be done at all), or do something with individual responses
    const results = await waitForResult();

    // the individual request/response-pairs can be found like this.
    // you may want to do something with them, but please note this means you need one additional request per request and may not be 1000+
    const each = await Promise.all(
      requests.map(async (request, index) => {
        return withResponse(index).then(async (res) =>
          res.ok ? ((await res.json()) as any).response_body?.by : res.text(),
        );
      }),
    );

    return new Response(JSON.stringify({ results, each }, undefined, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
};
