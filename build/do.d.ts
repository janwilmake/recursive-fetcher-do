import { DurableObject } from "cloudflare:workers";
export interface RecursiveFetcherEnv {
    RECURSIVE_FETCHER: DurableObjectNamespace;
}
interface RequestType {
    url: string;
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    index: number;
}
interface ResponseType {
    status: number;
    headers: Record<string, string>;
    body: string;
}
export declare function dodFetch(context: {
    env: RecursiveFetcherEnv;
    requests: Omit<RequestType, "index">[];
    rps?: number;
    windowDuration?: number;
}): Promise<ResponseType[]>;
export declare class RecursiveFetcherDO extends DurableObject {
    readonly state: DurableObjectState;
    readonly env: RecursiveFetcherEnv;
    private activeRequests;
    constructor(state: DurableObjectState, env: RecursiveFetcherEnv);
    fetch(request: Request): Promise<Response>;
    private handleRequests;
    private handleMultipleRequests;
}
export {};
