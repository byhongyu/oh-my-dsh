import {
  AgentSetupSchema,
  CapabilityPackSchema,
  type AgentSetup,
  type CapabilityPack,
} from "@oh-my-dsh/schema";

const VERSION = "0.1.0";

const coreSafety = CapabilityPackSchema.parse({
  apiVersion: "omdsh.dev/v1alpha1",
  kind: "CapabilityPack",
  metadata: {
    id: "dev.oh-my-dsh.core-safety",
    name: "Core Safety",
    version: VERSION,
    description: "Least-authority defaults and explicit output disclosure.",
    license: "MIT",
  },
  dependencies: [],
  instructions: [
    "Never disclose secrets or credentials.",
    "State material tool actions and unresolved risks in the final response.",
  ],
  workflows: [],
  tools: { allow: [], deny: [] },
  permissions: {
    network: "ask",
    filesystem: "read-only",
    shell: "deny",
    destructive: "deny",
    secrets: "deny",
    dataExport: "deny",
    brokerage: "deny",
  },
  plugins: [],
  output: { conventions: ["Disclose actions taken and unresolved risks."] },
});

const repositoryTools = CapabilityPackSchema.parse({
  apiVersion: "omdsh.dev/v1alpha1",
  kind: "CapabilityPack",
  metadata: {
    id: "dev.oh-my-dsh.repository-tools",
    name: "Repository Tools",
    version: VERSION,
    description:
      "Workspace file, search, editing, shell, Git, and test workflows.",
    license: "MIT",
  },
  dependencies: [{ id: coreSafety.metadata.id, version: VERSION }],
  instructions: [
    "Inspect repository instructions before editing and keep changes bounded.",
  ],
  workflows: [
    {
      id: "understand-repo",
      description:
        "Map repository instructions and relevant code before acting.",
      steps: [
        "Read repository guidance.",
        "Search for the relevant implementation and tests.",
        "Report the execution boundary.",
      ],
      tools: ["filesystem.read", "code.search", "git.status"],
    },
    {
      id: "plan-implement-test",
      description: "Plan a bounded change, edit it, and verify behavior.",
      steps: [
        "State the plan.",
        "Apply the smallest coherent edit.",
        "Run targeted and broader verification.",
      ],
      tools: [
        "filesystem.read",
        "code.search",
        "filesystem.patch",
        "shell.execute",
        "git.diff",
        "test.run",
      ],
    },
    {
      id: "review-current-diff",
      description: "Review the current diff for actionable defects.",
      steps: [
        "Read the diff.",
        "Trace affected behavior.",
        "Report findings by severity.",
      ],
      tools: ["git.diff", "filesystem.read", "code.search"],
    },
    {
      id: "diagnose-without-fixing",
      description: "Diagnose a failure without changing the repository.",
      steps: [
        "Reproduce the failure.",
        "Trace the failing path.",
        "Report evidence and likely cause.",
      ],
      tools: ["filesystem.read", "code.search", "shell.execute", "test.run"],
    },
  ],
  tools: {
    allow: [
      "filesystem.read",
      "code.search",
      "filesystem.patch",
      "shell.execute",
      "git.status",
      "git.diff",
      "test.run",
    ],
    deny: ["browser.automate", "deployment.execute", "git.commit", "git.push"],
  },
  permissions: {
    network: "ask",
    filesystem: "workspace-write",
    shell: "allow",
    destructive: "deny",
    secrets: "deny",
    dataExport: "deny",
    brokerage: "deny",
  },
  plugins: [
    {
      id: "agent-instructions",
      package: "@deepseek-ai/dsh-agent-instructions",
      version: "0.1.0-rc.6",
    },
  ],
});

const coding = AgentSetupSchema.parse({
  apiVersion: "omdsh.dev/v1alpha1",
  kind: "AgentSetup",
  metadata: {
    id: "dev.oh-my-dsh.coding",
    name: "Coding",
    version: VERSION,
    description:
      "Build, debug, test, and review software with bounded autonomy.",
    license: "MIT",
  },
  compatibility: { dsh: ">=0.1.0-rc.5 <0.2.0", adapters: ["dsh-rc5"] },
  capabilities: [
    { id: coreSafety.metadata.id, version: VERSION },
    { id: repositoryTools.metadata.id, version: VERSION },
  ],
  persona: {
    text: "You are a senior software engineer. Inspect first, state a plan, make bounded changes, and verify externally.",
  },
  instructions: {
    inline: ["Respect AGENTS.md and repository-local instructions."],
  },
  workflows: [],
  tools: { allow: [], deny: [] },
  permissions: {
    network: "ask",
    filesystem: "workspace-write",
    shell: "allow",
    destructive: "deny",
    secrets: "deny",
    dataExport: "deny",
    brokerage: "deny",
  },
  permissionElevations: {
    filesystem: "Coding requires bounded writes inside the selected workspace.",
    shell: "Coding requires the repository test runner and diagnostics.",
  },
  output: {
    conventions: [
      "Report the plan, changed files, tests run, and unresolved risks.",
    ],
  },
  examples: [],
});

const webResearch = CapabilityPackSchema.parse({
  apiVersion: "omdsh.dev/v1alpha1",
  kind: "CapabilityPack",
  metadata: {
    id: "dev.oh-my-dsh.web-research",
    name: "Web Research",
    version: VERSION,
    description: "Search, evidence capture, and claim verification workflows.",
    license: "MIT",
  },
  dependencies: [{ id: coreSafety.metadata.id, version: VERSION }],
  instructions: [
    "Prefer primary sources, capture citations, and distinguish source facts from inference.",
  ],
  workflows: [
    {
      id: "scope-question",
      description:
        "Define the question, decision criteria, and evidence threshold.",
      steps: [
        "Restate the question.",
        "Identify scope and exclusions.",
        "Set the evidence threshold.",
      ],
      tools: [],
    },
    {
      id: "source-discovery",
      description: "Find authoritative and disconfirming sources.",
      steps: [
        "Search primary sources.",
        "Search for counterevidence.",
        "Record source provenance.",
      ],
      tools: ["web.search"],
    },
    {
      id: "evidence-table",
      description:
        "Map material claims to supporting and contradicting evidence.",
      steps: [
        "Extract material claims.",
        "Attach sources.",
        "Record evidence quality and disagreement.",
      ],
      tools: ["web.search", "citation.capture"],
    },
    {
      id: "claim-verification",
      description: "Verify each material claim against available sources.",
      steps: [
        "Check source support.",
        "Seek disconfirmation.",
        "Flag unsupported precision.",
      ],
      tools: ["web.search", "citation.capture"],
    },
    {
      id: "synthesis",
      description:
        "Produce a cited answer with uncertainty and open questions.",
      steps: [
        "Separate fact from inference.",
        "Cite material claims.",
        "State confidence and open questions.",
      ],
      tools: ["citation.capture"],
    },
  ],
  tools: {
    allow: ["web.search", "citation.capture"],
    deny: ["web.fetch", "browser.automate"],
  },
  permissions: {
    network: "allow",
    filesystem: "read-only",
    shell: "deny",
    destructive: "deny",
    secrets: "deny",
    dataExport: "deny",
    brokerage: "deny",
  },
  plugins: [
    { id: "web", package: "@deepseek-ai/dsh-web", version: "0.1.0-rc.6" },
    {
      id: "web-search-deepseek",
      package: "@deepseek-ai/dsh-web-search-deepseek",
      version: "0.1.0-rc.6",
    },
    {
      id: "tool-web",
      package: "@deepseek-ai/dsh-tool-web",
      version: "0.1.0-rc.6",
      config: { fetch: false },
    },
  ],
});

const documentAnalysis = CapabilityPackSchema.parse({
  apiVersion: "omdsh.dev/v1alpha1",
  kind: "CapabilityPack",
  metadata: {
    id: "dev.oh-my-dsh.document-analysis",
    name: "Document Analysis",
    version: VERSION,
    description:
      "Portable document extraction and page-aware evidence conventions.",
    license: "MIT",
  },
  dependencies: [{ id: coreSafety.metadata.id, version: VERSION }],
  instructions: [
    "Preserve page references and distinguish extracted text from interpretation.",
  ],
  workflows: [
    {
      id: "document-evidence",
      description: "Extract claims and tables from user-provided documents.",
      steps: [
        "Read the declared document.",
        "Extract text and tables.",
        "Attach page-level references.",
      ],
      tools: ["document.read", "document.extract", "table.extract"],
    },
  ],
  tools: {
    allow: ["document.read", "document.extract", "table.extract"],
    deny: [],
  },
  permissions: {
    network: "deny",
    filesystem: "read-only",
    shell: "deny",
    destructive: "deny",
    secrets: "deny",
    dataExport: "deny",
    brokerage: "deny",
  },
  plugins: [],
});

const financialDocuments = CapabilityPackSchema.parse({
  apiVersion: "omdsh.dev/v1alpha1",
  kind: "CapabilityPack",
  metadata: {
    id: "dev.oh-my-dsh.financial-documents",
    name: "Financial Documents",
    version: VERSION,
    description:
      "Filing provenance, valuation scenarios, and investment risk workflows.",
    license: "MIT",
  },
  dependencies: [
    { id: webResearch.metadata.id, version: VERSION },
    { id: documentAnalysis.metadata.id, version: VERSION },
  ],
  instructions: [
    "Keep narrative, evidence, assumptions, and price-sensitive conclusions separate.",
  ],
  workflows: [
    {
      id: "company-deep-dive",
      description:
        "Analyze a company from filings, reported results, and competitive evidence.",
      steps: [
        "Collect primary financial evidence.",
        "Analyze business quality and competition.",
        "State thesis and disconfirming evidence.",
      ],
      tools: ["web.search", "document.read", "financial.calculate"],
    },
    {
      id: "earnings-review",
      description: "Reconcile quarterly results with the prior thesis.",
      steps: [
        "Compare reported results with assumptions.",
        "Identify changed evidence.",
        "Update risks and catalysts.",
      ],
      tools: [
        "web.search",
        "document.read",
        "table.extract",
        "financial.calculate",
      ],
    },
    {
      id: "thesis-update",
      description:
        "Update a thesis while preserving prior assumptions and changes.",
      steps: [
        "Restate the prior thesis.",
        "Record new evidence.",
        "Explain each changed conclusion.",
      ],
      tools: ["web.search", "document.read", "citation.capture"],
    },
    {
      id: "valuation-scenarios",
      description: "Build reproducible bull, base, and bear valuation cases.",
      steps: [
        "Declare assumptions.",
        "Calculate each scenario.",
        "Show sensitivity to key variables.",
      ],
      tools: ["financial.calculate", "spreadsheet.calculate"],
    },
    {
      id: "risk-register",
      description: "Track risks, catalysts, and disconfirming signals.",
      steps: [
        "Identify material risks.",
        "Define observable disconfirming signals.",
        "Rank impact and uncertainty.",
      ],
      tools: ["web.search", "citation.capture", "market-data.read"],
    },
  ],
  tools: {
    allow: ["financial.calculate", "spreadsheet.calculate", "market-data.read"],
    deny: ["brokerage.execute", "portfolio.rebalance"],
  },
  permissions: {
    network: "allow",
    filesystem: "read-only",
    shell: "deny",
    destructive: "deny",
    secrets: "deny",
    dataExport: "deny",
    brokerage: "deny",
  },
  plugins: [],
});

const research = AgentSetupSchema.parse({
  apiVersion: "omdsh.dev/v1alpha1",
  kind: "AgentSetup",
  metadata: {
    id: "dev.oh-my-dsh.research",
    name: "Research",
    version: VERSION,
    description:
      "Conduct cited, evidence-driven research with explicit uncertainty.",
    license: "MIT",
  },
  compatibility: { dsh: ">=0.1.0-rc.5 <0.2.0", adapters: ["dsh-rc5"] },
  capabilities: [
    { id: coreSafety.metadata.id, version: VERSION },
    { id: webResearch.metadata.id, version: VERSION },
    { id: documentAnalysis.metadata.id, version: VERSION },
  ],
  persona: {
    text: "You are an evidence-driven researcher. Prefer primary sources, separate fact from inference, and seek disconfirmation.",
  },
  instructions: {
    inline: [
      "Do not produce unsupported precise claims or source-free factual prose.",
    ],
  },
  workflows: [],
  tools: { allow: [], deny: ["shell.execute", "filesystem.write"] },
  permissions: {
    network: "allow",
    filesystem: "read-only",
    shell: "deny",
    destructive: "deny",
    secrets: "deny",
    dataExport: "deny",
    brokerage: "deny",
  },
  permissionElevations: {
    network:
      "Research requires source discovery through the host search provider.",
  },
  output: {
    conventions: [
      "Lead with an executive answer.",
      "Include an evidence table, disagreements, confidence, open questions, and citations.",
    ],
  },
  examples: [],
});

const investing = AgentSetupSchema.parse({
  apiVersion: "omdsh.dev/v1alpha1",
  kind: "AgentSetup",
  metadata: {
    id: "dev.oh-my-dsh.investing",
    name: "Investing",
    version: VERSION,
    description:
      "Analyze companies, filings, valuation scenarios, and thesis risks without trading.",
    license: "MIT",
  },
  compatibility: { dsh: ">=0.1.0-rc.5 <0.2.0", adapters: ["dsh-rc5"] },
  capabilities: [
    { id: coreSafety.metadata.id, version: VERSION },
    { id: financialDocuments.metadata.id, version: VERSION },
  ],
  persona: {
    text: "You are a skeptical investment analyst. Distinguish narrative, evidence, assumptions, and price-sensitive conclusions.",
  },
  instructions: {
    inline: [
      "Never place orders, rebalance a portfolio, or present personalized financial instructions.",
    ],
  },
  workflows: [],
  tools: { allow: [], deny: ["brokerage.execute", "portfolio.rebalance"] },
  permissions: {
    network: "allow",
    filesystem: "read-only",
    shell: "deny",
    destructive: "deny",
    secrets: "deny",
    dataExport: "deny",
    brokerage: "deny",
  },
  permissionElevations: {
    network:
      "Investing research requires filings and market evidence through read-only providers.",
  },
  output: {
    conventions: [
      "Report thesis, evidence, catalysts, explicit valuation assumptions, bull/base/bear cases, risks, and disconfirming evidence.",
    ],
  },
  examples: [],
});

export const capabilityPacks: CapabilityPack[] = [
  coreSafety,
  repositoryTools,
  webResearch,
  documentAnalysis,
  financialDocuments,
];

export const agentSetups: Record<
  "coding" | "research" | "investing",
  AgentSetup
> = {
  coding,
  research,
  investing,
};
