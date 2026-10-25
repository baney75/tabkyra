/** Text files bundled by cli/scripts/build.mjs (the release public key). */
declare module "*.pub" {
	const text: string;
	export default text;
}
