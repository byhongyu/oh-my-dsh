import { z } from "zod";

const API_VERSION = "omdsh.dev/v1alpha1" as const;

const identifier = z
  .string()
  .min(3)
  .max(160)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    "must be a lowercase reverse-DNS identifier",
  );

const semver = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    "must be SemVer",
  );

function hasNoControlCharacters(value: string): boolean {
  return [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 0x20 && code !== 0x7f;
  });
}

function isPortableRelativePath(value: string): boolean {
  if (value.length === 0 || value.includes("\0") || value.includes("\\"))
    return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => {
    const windowsBase = segment.split(".")[0]!.toLowerCase();
    return (
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      segment.normalize("NFC") === segment &&
      !/[<>:"|?*]/.test(segment) &&
      !/[. ]$/.test(segment) &&
      ![...segment].some((character) => character.charCodeAt(0) <= 0x1f) &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(windowsBase)
    );
  });
}

export const PortablePathSchema = z
  .string()
  .max(512)
  .refine(isPortableRelativePath, "must be a confined portable relative path");

export const MetadataSchema = z
  .object({
    id: identifier,
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine(hasNoControlCharacters, "must not contain control characters"),
    version: semver,
    description: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine(hasNoControlCharacters, "must not contain control characters")
      .optional(),
    license: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine(hasNoControlCharacters, "must not contain control characters"),
  })
  .strict();

export const DependencySchema = z
  .object({
    id: identifier,
    version: semver,
  })
  .strict();

const personaSchema = z.union([
  z.object({ file: PortablePathSchema }).strict(),
  z.object({ text: z.string().trim().min(1).max(32_000) }).strict(),
]);

const instructionsSchema = z
  .object({
    files: z.array(PortablePathSchema).max(64).optional(),
    inline: z.array(z.string().trim().min(1).max(16_000)).max(128).optional(),
  })
  .strict();

export const WorkflowSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    description: z.string().trim().min(1).max(500),
    steps: z.array(z.string().trim().min(1).max(2_000)).min(1).max(64),
    tools: z.array(z.string().trim().min(1).max(200)).max(64),
  })
  .strict();

export const ToolsSchema = z
  .object({
    allow: z.array(z.string().trim().min(1).max(200)).max(256),
    deny: z.array(z.string().trim().min(1).max(200)).max(256).optional(),
  })
  .strict();

export const PermissionsSchema = z
  .object({
    network: z.enum(["allow", "ask", "deny"]).optional(),
    filesystem: z.enum(["workspace-write", "read-only", "deny"]).optional(),
    shell: z.enum(["allow", "ask", "deny"]).optional(),
    destructive: z.enum(["allow", "ask", "deny"]).optional(),
    secrets: z.enum(["allow", "ask", "deny"]).optional(),
    dataExport: z.literal("deny").optional(),
    brokerage: z.enum(["allow", "deny"]).optional(),
  })
  .strict();

export const PluginSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    package: z.string().regex(/^@deepseek-ai\/[a-z0-9-]+$/),
    version: semver,
    config: z.record(z.string(), z.json()).optional(),
  })
  .strict();

const outputSchema = z
  .object({ conventions: z.array(z.string().trim().min(1).max(2_000)).max(64) })
  .strict();

export const CapabilityPackSchema = z
  .object({
    apiVersion: z.literal(API_VERSION),
    kind: z.literal("CapabilityPack"),
    metadata: MetadataSchema,
    dependencies: z.array(DependencySchema).max(64),
    persona: z.string().trim().min(1).max(32_000).optional(),
    instructions: z
      .array(z.string().trim().min(1).max(16_000))
      .max(128)
      .optional(),
    workflows: z.array(WorkflowSchema).max(128),
    tools: ToolsSchema,
    permissions: PermissionsSchema,
    plugins: z.array(PluginSchema).max(64).optional(),
    output: outputSchema.optional(),
  })
  .strict();

export const AgentSetupSchema = z
  .object({
    apiVersion: z.literal(API_VERSION),
    kind: z.literal("AgentSetup"),
    metadata: MetadataSchema,
    compatibility: z
      .object({
        dsh: z.string().trim().min(1).max(200),
        adapters: z
          .array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/))
          .min(1)
          .max(16),
      })
      .strict(),
    capabilities: z.array(DependencySchema).max(64),
    persona: personaSchema,
    instructions: instructionsSchema,
    workflows: z.array(WorkflowSchema).max(128),
    tools: ToolsSchema,
    permissions: PermissionsSchema,
    permissionElevations: z
      .record(z.string(), z.string().trim().min(1).max(1_000))
      .optional(),
    output: outputSchema,
    examples: z.array(PortablePathSchema).max(64),
  })
  .strict()
  .superRefine((setup, context) => {
    const paths = [
      ...("file" in setup.persona ? [setup.persona.file] : []),
      ...(setup.instructions.files ?? []),
      ...setup.examples,
    ];
    const folded = new Set<string>();
    for (const path of paths) {
      const key = path.toLocaleLowerCase("en-US");
      if (folded.has(key)) {
        context.addIssue({
          code: "custom",
          message: `declared file path collides across hosts: ${path}`,
          path: ["instructions", "files"],
        });
      }
      folded.add(key);
    }
  });

const LocalMetadataSchema = MetadataSchema.refine(
  (metadata) => metadata.id.startsWith("local."),
  {
    message: "fork metadata id must use the local.* namespace",
    path: ["id"],
  },
);

export const CustomAgentSetupSchema = z
  .object({
    apiVersion: z.literal(API_VERSION),
    kind: z.literal("AgentSetupFork"),
    metadata: LocalMetadataSchema,
    extends: DependencySchema,
    overrides: z
      .object({
        instructions: z
          .object({
            append: z
              .array(z.string().trim().min(1).max(16_000))
              .max(128)
              .optional(),
            replace: z
              .array(z.string().trim().min(1).max(16_000))
              .max(128)
              .optional(),
          })
          .strict()
          .optional(),
        workflows: z
          .object({
            enable: z
              .array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/))
              .max(128)
              .optional(),
            disable: z
              .array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/))
              .max(128)
              .optional(),
          })
          .strict()
          .optional(),
        permissions: PermissionsSchema.optional(),
        permissionElevations: z
          .record(z.string(), z.string().trim().min(1).max(1_000))
          .optional(),
        output: z
          .object({
            append: z.array(z.string().trim().min(1).max(2_000)).max(64),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

export type AgentSetup = z.infer<typeof AgentSetupSchema>;
export type CapabilityPack = z.infer<typeof CapabilityPackSchema>;
export type CustomAgentSetup = z.infer<typeof CustomAgentSetupSchema>;
export type PermissionSet = z.infer<typeof PermissionsSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;
export type PluginRequirement = z.infer<typeof PluginSchema>;

export function parseAgentSetup(input: unknown): AgentSetup {
  return AgentSetupSchema.parse(input);
}

export function parseCapabilityPack(input: unknown): CapabilityPack {
  return CapabilityPackSchema.parse(input);
}

export function parseCustomAgentSetup(input: unknown): CustomAgentSetup {
  return CustomAgentSetupSchema.parse(input);
}
