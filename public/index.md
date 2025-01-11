# Distributed Fetching at Scale with Cloudflare Durable Objects

When building applications on Cloudflare Workers, you might encounter two common limitations: a maximum of 1,000 subrequests per worker instance and a limit of 6 concurrent requests. While these limits help ensure platform stability, they can pose challenges when you need to fetch data from thousands of endpoints efficiently.

Enter dodfetch: a TypeScript library that leverages Cloudflare's Durable Objects to distribute HTTP requests across multiple instances, effectively bypassing these limits while maintaining controlled concurrency.

## The Challenge

Consider a scenario where you need to fetch 10,000 items from the Hacker News API. With standard Workers, you'd hit the subrequest limit long before completing the task. Even if you could make all the requests, managing them efficiently while respecting rate limits and handling failures would be complex.

## How dodfetch Works

dodfetch uses a clever approach of nested Durable Objects to distribute the workload. Here's how it manages to handle thousands of requests efficiently:

1. Request Distribution: The main worker divides the total requests into manageable chunks based on your specified rate limit (defaulting to 1,000 requests per second).

2. Nested Processing: For each chunk that's too large for a single Durable Object, the system creates a tree of Durable Objects, with each layer handling a portion of the requests.

3. Rate Limiting: Built-in rate limiting ensures you don't overwhelm target APIs, with configurable requests per second (rps) and window duration.

4. Automatic Retries: The system includes exponential backoff with jitter for failed requests, maximizing success rates while being respectful to external services.

Here's a simple example of how to use dodfetch:

```typescript
import { RecursiveFetcherEnv, dodFetch } from "dodfetch";
export { RecursiveFetcherDO };

interface Env extends RecursiveFetcherEnv {
  SECRET: string;
}

export default {
  fetch: async (request: Request, env: Env) => {
    // Create 10,000 requests to the Hacker News API
    const requests = Array.from({ length: 10000 }, (_, i) => ({
      url: `https://hacker-news.firebaseio.com/v0/item/${i + 1}.json`,
    }));

    const responses = await dodFetch({
      env,
      requests,
      rps: 5000, // Optional: set requests per second
      windowDuration: 1000, // Optional: set window duration in ms
    });

    return new Response(JSON.stringify(responses));
  },
};
```

## Under the Hood

The magic happens in the RecursiveFetcherDO class, which implements a sophisticated request handling system:

1. For small batches (<=1 request by default), it directly executes the requests with retry logic.
2. For larger batches, it splits them into chunks and creates child Durable Objects to handle each chunk.
3. Each layer implements exponential backoff with jitter to handle rate limiting and failures gracefully.

```typescript
const processSingleChunk = async (chunk: RequestType[]) => {
  let retries = 0;
  let delay = INITIAL_BACKOFF_MS;

  while (retries < MAX_RETRIES) {
    try {
      const id =
        chunk.length <= fetchesPerDO
          ? this.env.RECURSIVE_FETCHER.idFromName(String(chunk[0].index))
          : this.env.RECURSIVE_FETCHER.newUniqueId();

      const fetcher = this.env.RECURSIVE_FETCHER.get(id);
      // ... handle the request
    } catch (error) {
      retries++;
      if (retries === MAX_RETRIES) {
        return handleMaxRetriesExceeded(chunk);
      }
      delay = calculateNextDelay(delay);
      await sleep(delay);
    }
  }
};
```

## Performance and Results

In testing, dodfetch has shown impressive performance:

- 100,000 requests at 5,000 RPS: Completed in ~26 seconds
- 1,000,000 requests at 5,000 RPS: Completed in ~209 seconds

These results demonstrate near-linear scaling, with the system efficiently managing large volumes of requests while maintaining controlled concurrency.

## Setting Up dodfetch

To use dodfetch in your Worker, you'll need:

1. A Durable Object binding in your wrangler.toml:

```toml
[durable_objects]
bindings = [{ name = "RECURSIVE_FETCHER", class_name = "RecursiveFetcherDO" }]
```

2. The proper environment interface:

```typescript
interface Env extends RecursiveFetcherEnv {
  // Your other environment variables
}
```

## Future Improvements

We're actively working on several enhancements:

1. Response storage with automatic cleanup
2. Improved error reporting and statistics
3. Support for more complex request patterns
4. Better handling of edge cases with large request volumes

## Conclusion

dodfetch demonstrates how Cloudflare's Durable Objects can be used to build powerful distributed systems. By cleverly managing request distribution and implementing robust retry logic, it provides a reliable solution for handling large volumes of HTTP requests within the Workers ecosystem.

Whether you're building a web scraper, aggregating API responses, or just need to make a lot of HTTP requests efficiently, dodfetch provides a battle-tested solution that scales with your needs.

Try it out today with `npm install dodfetch` and let us know your experiences!
