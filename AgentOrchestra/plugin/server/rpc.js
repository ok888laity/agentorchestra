import { Rpc } from "@opencode/plugin/rpc";

const text = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false
};

// OpenCode 2.4.2's RPC validator assumes every method has an input schema.
// An omitted input becomes `undefined` and fails with `"~standard" in undefined`.
const none = {
  type: "object",
  properties: {},
  additionalProperties: false
};

export const Orchestra = Rpc.define({
  id: "agentorchestra",
  methods: {
    status: { input: none, output: text },
    classify: { input: none, output: text },
    confirmProvider: {
      input: {
        type: "object",
        properties: {
          provider: { type: "string" },
          billing: { type: "string" },
          privacy: { type: "string" },
          enabled: { type: "boolean" }
        },
        required: ["provider", "billing", "privacy", "enabled"],
        additionalProperties: false
      },
      output: text
    },
    examples: { input: none, output: text },
    submitPlan: {
      input: {
        type: "object",
        properties: { plan: { type: "string" } },
        required: ["plan"],
        additionalProperties: false
      },
      output: text
    },
    pool: { input: none, output: text },
    routePreview: {
      input: {
        type: "object",
        properties: { taskId: { type: "string" } },
        required: ["taskId"],
        additionalProperties: false
      },
      output: text
    },
    run: { input: none, output: text },
    checkUpdate: { input: none, output: text },
    update: { input: none, output: text }
  }
});
