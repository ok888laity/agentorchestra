import { Rpc } from "@opencode/plugin/rpc";

const text = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false
};

export const Orchestra = Rpc.define({
  id: "agentorchestra",
  methods: {
    status: { output: text },
    classify: { output: text },
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
    examples: { output: text },
    submitPlan: {
      input: {
        type: "object",
        properties: { plan: { type: "string" } },
        required: ["plan"],
        additionalProperties: false
      },
      output: text
    },
    pool: { output: text },
    routePreview: {
      input: {
        type: "object",
        properties: { taskId: { type: "string" } },
        required: ["taskId"],
        additionalProperties: false
      },
      output: text
    },
    run: { output: text }
  }
});
