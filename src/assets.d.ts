/** Files imported `with { type: "file" }` resolve to their path, which `bun build --compile` embeds in the binary. */
declare module "*.png" {
  const path: string;
  export default path;
}

declare module "*.svg" {
  const path: string;
  export default path;
}
