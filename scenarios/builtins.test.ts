import { describe, expect, it } from "vitest";

import { compilePreset } from "@oh-my-dsh/adapter-dsh-rc5";
import { agentSetups, capabilityPacks } from "@oh-my-dsh/catalog";
import { resolveSetup } from "@oh-my-dsh/core";

const coding = resolveSetup(agentSetups.coding, capabilityPacks);
const research = resolveSetup(agentSetups.research, capabilityPacks);
const investing = resolveSetup(agentSetups.investing, capabilityPacks);

describe("Coding deterministic scenarios", () => {
  it("supports a bounded feature through inspect, patch, and test tools", () => {
    expect(coding.tools.allow).toEqual(
      expect.arrayContaining([
        "filesystem.read",
        "code.search",
        "filesystem.patch",
        "test.run",
      ]),
    );
  });

  it("supports diagnosis without mutation as an explicit workflow", () => {
    expect(
      coding.workflows.find(
        (workflow) => workflow.id === "diagnose-without-fixing",
      )?.steps,
    ).toHaveLength(3);
  });

  it("supports current-diff review without automatic commit or push", () => {
    expect(coding.workflows.map((workflow) => workflow.id)).toContain(
      "review-current-diff",
    );
    expect(coding.tools.deny).toEqual(
      expect.arrayContaining(["git.commit", "git.push"]),
    );
  });

  it("denies destructive commands and secrets by policy", () => {
    expect(coding.permissions).toMatchObject({
      destructive: "deny",
      secrets: "deny",
    });
  });
});

describe("Research deterministic scenarios", () => {
  it("supports source discovery while arbitrary URL fetch stays excluded", () => {
    expect(research.tools.allow).toContain("web.search");
    expect(research.tools.deny).toContain("web.fetch");
  });

  it("defines a claim/evidence workflow with citation capture", () => {
    expect(
      research.workflows.find((workflow) => workflow.id === "evidence-table")
        ?.tools,
    ).toContain("citation.capture");
  });

  it("requires confidence and open questions in its output", () => {
    expect(research.output.conventions.join(" ")).toMatch(
      /confidence.*open questions/i,
    );
  });

  it("cannot use shell or mutate local files", () => {
    expect(research.permissions).toMatchObject({
      filesystem: "read-only",
      shell: "deny",
    });
    expect(research.tools.allow).not.toContain("shell.execute");
  });
});

describe("Investing deterministic scenarios", () => {
  it("requires primary evidence for a company deep dive", () => {
    expect(
      investing.workflows.find(
        (workflow) => workflow.id === "company-deep-dive",
      )?.steps[0],
    ).toMatch(/primary financial evidence/i);
  });

  it("makes valuation assumptions reproducible", () => {
    expect(
      investing.workflows.find(
        (workflow) => workflow.id === "valuation-scenarios",
      )?.tools,
    ).toEqual(
      expect.arrayContaining(["financial.calculate", "spreadsheet.calculate"]),
    );
  });

  it("tracks disconfirming signals in a risk register", () => {
    expect(
      investing.workflows
        .find((workflow) => workflow.id === "risk-register")
        ?.steps.join(" "),
    ).toMatch(/disconfirming signals/i);
  });

  it("denies brokerage execution in policy, tools, and persona instructions", () => {
    expect(investing.permissions.brokerage).toBe("deny");
    expect(investing.tools.deny).toContain("brokerage.execute");
    expect(investing.instructions.join(" ")).toMatch(/never place orders/i);
  });
});

describe("rc.5/rc.6 adapter capability truthfulness", () => {
  it("warns rather than claiming stock DSH supports document, spreadsheet, or market-data tools", () => {
    expect(compilePreset(research).warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^document\.read /),
        expect.stringMatching(/^document\.extract /),
      ]),
    );
    expect(compilePreset(investing).warnings.join("\n")).toMatch(
      /market-data\.read.*not available/i,
    );
  });
});
