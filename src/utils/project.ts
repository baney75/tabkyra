export const REPO_URL = "https://github.com/baney75/tabkyra";
export const RELEASES_URL = `${REPO_URL}/releases/latest`;
export const LATEST_RELEASE_API = "https://api.github.com/repos/baney75/tabkyra/releases/latest";
export const UPSTREAM_URL = "https://github.com/badlogic/sitegeist";

/** Fetch the latest released version from GitHub. Returns undefined when there is no release yet. */
export async function fetchLatestVersion(): Promise<string | undefined> {
	const response = await fetch(LATEST_RELEASE_API, { cache: "no-cache" });
	if (response.status === 404) return undefined;
	if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
	const data = (await response.json()) as { tag_name?: string };
	return data.tag_name?.replace(/^v/, "");
}
