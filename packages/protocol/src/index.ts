export type SourceFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Runtime capabilities injected into HTML-scraping sources. */
export type SourceRuntime = {
  fetch: SourceFetch;
  parseHtml: (html: string) => Document;
};

export type ConnectionState = {
  serverUrl: string | null;
  transport: "direct" | "server";
  clientAccountId: number | null;
  serverSession: { serverUrl: string; accountId: number; email?: string; token: string } | null;
  activeLibrary: "client" | "server" | null;
  activePairId: string | null;
};
