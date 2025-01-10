> WIP

There seems to be a bug now that, sometimes, it doesn't process all. With https://recursive-fetcher-do.githuq.workers.dev/?secret=******&max=1050 it randomly shows 200: 1050 or 200:1000. Strange cap!

I've chosen to store the results in the same DO as they are fetched, because this will allow for the highest possible ratelimit. May be changed in the future.

Notes: Depending on your desired concurrency, in development this is very slow with large sets of requests, but in prod it's faster.
