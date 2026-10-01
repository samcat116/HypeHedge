import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Workflow = {
	on: Record<
		string,
		{
			branches?: string[];
			inputs?: Record<
				string,
				{ required: boolean; type: string; default: boolean }
			>;
		}
	>;
	jobs: Record<string, { if?: string }>;
};

function readWorkflow(name: string): Workflow {
	return parse(
		readFileSync(
			new URL(`../../.github/workflows/${name}.yml`, import.meta.url),
			"utf8",
		),
	) as Workflow;
}

describe("production workflow authorization", () => {
	for (const name of ["deploy", "release"]) {
		describe(name, () => {
			const workflow = readWorkflow(name);
			it("accepts only manual dispatch with approval defaulting to false", () => {
				expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
				expect(
					workflow.on.workflow_dispatch.inputs?.rollout_approved,
				).toMatchObject({ required: true, type: "boolean", default: false });
			});

			it.each([
				{ event: "push", ref: "refs/heads/main", approved: true, runs: false },
				{
					event: "pull_request",
					ref: "refs/heads/main",
					approved: true,
					runs: false,
				},
				{
					event: "workflow_dispatch",
					ref: "refs/heads/main",
					approved: false,
					runs: false,
				},
				{
					event: "workflow_dispatch",
					ref: "refs/heads/main",
					approved: undefined,
					runs: false,
				},
				{
					event: "workflow_dispatch",
					ref: "refs/heads/feature",
					approved: true,
					runs: false,
				},
				{
					event: "workflow_dispatch",
					ref: "refs/tags/v1",
					approved: true,
					runs: false,
				},
				{
					event: "workflow_dispatch",
					ref: "refs/heads/main",
					approved: true,
					runs: true,
				},
			])(
				"$event on $ref with approval $approved runs: $runs",
				({ event, ref, approved, runs }) => {
					for (const job of Object.values(workflow.jobs)) {
						expect(job.if).toBeTypeOf("string");
						// These gates deliberately use only the JS-compatible subset of
						// Actions expressions: identifiers, string/boolean equality and &&.
						const result = runInNewContext(
							`(${job.if})`,
							{
								github: { event_name: event, ref },
								inputs: { rollout_approved: approved },
							},
							{ timeout: 100 },
						);
						expect(Boolean(result)).toBe(runs);
					}
				},
			);
		});
	}

	it("keeps verification active on PRs and main pushes after merge", () => {
		const workflow = readWorkflow("pr");
		expect(workflow.on.pull_request.branches).toContain("main");
		expect(workflow.on.push.branches).toContain("main");
		expect(workflow.jobs.check.if).toBeUndefined();
	});
});
