/**
 * `url` as `fetch` reaches it: parsed as a URL (scheme and host lowercased, a default port dropped, dot segments
 * resolved) and without trailing slashes; a value that does not parse only loses its trailing slashes. Spellings that
 * reach the same endpoint give the same string, so it names the endpoint where a record or a cache key compares one.
 */
export function endpointUrl(url: string): string {
	return (URL.parse(url)?.href ?? url).replace(/\/+$/, "");
}

/**
 * {@link endpointUrl} of `url` without the parts a credential hides in: its userinfo, query and fragment. A
 * provider's key can sit in the userinfo, the part before the `@` of a URL's authority, or in the query
 * (`https://host/v1?key=...`), so a record written to a
 * session file names the endpoint by this; what such a record tells apart is the server and the path a request
 * reaches. A value that does not parse is left to {@link endpointUrl}.
 */
export function endpointUrlWithoutCredentials(url: string): string {
	const parsed = URL.parse(url);
	if (!parsed) return endpointUrl(url);
	parsed.username = "";
	parsed.password = "";
	parsed.search = "";
	parsed.hash = "";
	return parsed.href.replace(/\/+$/, "");
}
