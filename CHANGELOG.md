# January 10, 2025

This was done after carrying out all these [experiments](https://github.com/janwilmake/nested-fetch-experiments)

Is it possible to alter the implementation such that we can configure the amount of URLs fetched in the base case (if(this.urls.length < FETCHES_PER_DO))?

And can we somehow set the max requests per time unit?

A naive Ratleimiter in the DO won't work because there is a separate ratelimit in each DO and they are in different places. a central ratleimiter DO won't work either because it would be under a too high load as I want to have more than 10k RPS. but maybe we can ratelimit just on Requests per window, not on concurrency, calculate the amount of requests per 100ms, then iterate on sending a chunk each 100ms to have proper concurrency.

That could be what we do in the worker fetch handler.

Result: With a controlled max concurrency, I finally achieved a million requests and it took a very reliable 208 seconds, just 8 seconds after it released the last batch.

- `amount=100000, ratelimit=5000`: {"results":{"200":100000},"duration":25611}
- `amount=1000000, rateLimit=5000`: {"results":{"200":1000000},"duration":208854}

New version:

- Limit max concurrency to 5000rps but in a way that you can set up your own ratelimit unit
- Allow passing requests and immediately getting a comprised URL and an individual URL for each response back
- Allow getting these URLs after it's done
- Allow a callback after its done.
- Also allow retrieving all responses in the response (no url needed)
- Ensure each DO retains the response and is removed 1 hour after full completion.

After this is there, let's make it an easy to import DO so it's installable/usable by anyone. It's basically a queue abstraction without requiring to create a queue in wrangler, and it has max 5000 RPS, which is much higher than a single queue could probably do.

Create `pdoRequest(Request[])` which just executes it in as many DOs as needed

TODO:

- this works: https://recursive-fetcher-do.githuq.workers.dev/?secret=secret&start=1000&max=900 but more than 1000 doesn't yet. is that desirable?
