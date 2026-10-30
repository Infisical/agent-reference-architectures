import type { ModalClient, Image } from "modal";
import { WORKSPACE_DIR } from "./run.js";

/** MODAL_IMAGE's default: the image builtinImage defines. */
export const BUILTIN_IMAGE = "builtin";

export const SANDBOX_USER = "user";

const NODE_IMAGE = "node:24-bookworm-slim";
const INFISICAL_CLI_VERSION = "0.44.2";
const CLAUDE_CODE_VERSION = "2.1.292";

/**
 * The sandbox image, the Modal counterpart of SPACE's `coding-agent:v1` template: Node 24, Git,
 * the Infisical CLI and Claude Code, at the versions verified against SPACE (docs/contract.md),
 * and a non-root `user` (uid 2000) whose workspace the bootstrap runs in. Modal caches each layer
 * by its commands, so building it again is a no-op until this file changes.
 */
function builtinImage(modal: ModalClient): Image {
  return modal.images.fromRegistry(NODE_IMAGE).dockerfileCommands([
    "RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*",
    `RUN npm install -g @infisical/cli@${INFISICAL_CLI_VERSION} @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force`,
    `RUN useradd --create-home --uid 2000 --shell /bin/bash ${SANDBOX_USER} && install -d -o ${SANDBOX_USER} -g ${SANDBOX_USER} ${WORKSPACE_DIR}`,
  ]);
}

/**
 * Resolves `MODAL_IMAGE`: `builtin` is the image above, an `im-...` ID is a prebuilt image, and
 * anything else is the name of an image published with Image.publish (`name` or `name:tag`).
 */
export async function resolveImage(modal: ModalClient, ref: string): Promise<Image> {
  if (ref === BUILTIN_IMAGE) return builtinImage(modal);
  if (ref.startsWith("im-")) return modal.images.fromId(ref);
  return modal.images.fromName(ref);
}
