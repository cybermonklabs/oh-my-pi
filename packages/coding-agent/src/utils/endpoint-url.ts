/**
 * `url` as `fetch` reaches it: parsed as a URL (scheme and host lowercased, a default port dropped, dot segments
 * resolved) and without trailing slashes; a value that does not parse only loses its trailing slashes. Spellings that
 * reach the same endpoint give the same string, so it names the endpoint where a record or a cache key compares one.
 */
export function endpointUrl(url: string): string {
	return (URL.parse(url)?.href ?? url).replace(/\/+$/, "");
}
