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
    const requests = Array.from({ length: 10 }, (_, i) => ({
      url: `https://hacker-news.firebaseio.com/v0/item/${Math.ceil(
        Math.random() * 42000000,
      )}.json`,
    }));

    console.log(requests);

    const { waitForResult, withResponse } = createFetcher({
      env,
      requests,
    });

    // we can wait for all and do something with that, or do something with individual responses
    const results = await waitForResult();

    const each = await Promise.all(
      requests.map(async (request, index) => {
        return withResponse(index).then((res) =>
          res.ok ? res.json() : res.text(),
        );
      }),
    );

    return new Response(JSON.stringify({ results, each }, undefined, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
};
