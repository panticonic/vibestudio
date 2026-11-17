import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { transformSync } from "esbuild";

const require = createRequire(import.meta.url);
const host = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { requireDevelopmentTemplateCheckouts } = require("../src/dev/developmentTemplateConfig.cjs");
const checkouts = requireDevelopmentTemplateCheckouts(host).checkouts;
const base = checkouts.base;

/** Execute the real suite fixture after relocation, without opening a model or compiling its program. */
function relocatedSuite(programRoot) {
  const source = fs.readFileSync(path.join(programRoot, "suite.ts"), "utf8");
  const { code } = transformSync(source, {
    sourcefile: "/emitted/adaptation/suite.ts",
    loader: "ts",
    format: "cjs",
    target: "es2022",
  });
  const module = { exports: {} };
  const importForFixture = (specifier) => {
    if (specifier === "@workspace/natlang/evaluation")
      return { defineEvaluationSuite: (suite) => suite };
    if (specifier === "@workspace/natlang/model") {
      return {
        loadModelConfiguration: () => ({ choice: {} }),
        executorIdentityForChoice: () => ({ id: "fixture-test" }),
      };
    }
    return require(specifier);
  };
  new Function("require", "module", "exports", code)(importForFixture, module, module.exports);
  return module.exports.default;
}

test("relocated documentation fixture reads the source catalog and composed workspace", async () => {
  const programRoot = path.join(base, "skills/sandbox/help");
  const suite = relocatedSuite(programRoot);
  let services;
  const fixture = await suite.fixture.create(
    { input: { function: "locateDoc", question: "blobstore" } },
    {
      programRoot,
      runtime: {
        run: (fn, options) => {
          services = options.services;
          return fn();
        },
      },
      loadFreshProgram: async () => ({
        docHelp: async () => ({
          markdown: await services.fs.readText("skills/sandbox/SKILL.md"),
          entries: await services.docs.search("blobstore"),
        }),
      }),
    }
  );
  const result = await fixture.execute();
  assert.equal(
    result.markdown.text,
    fs.readFileSync(path.join(base, "skills/sandbox/SKILL.md"), "utf8")
  );
  const sourceCatalog = JSON.parse(fs.readFileSync(path.join(programRoot, "catalog.json"), "utf8"));
  assert.ok(result.entries.length > 0);
  assert.ok(
    result.entries.every((entry) => sourceCatalog.some((source) => source.id === entry.id))
  );
});

test("documentation recovery does not require the source catalog or workspace", async () => {
  const suite = relocatedSuite(path.join(base, "skills/sandbox/help"));
  let services;
  const fixture = await suite.fixture.create(
    { input: { function: "recoverFromFailure", failure: {} } },
    {
      programRoot: "/no-fixture-assets",
      runtime: {
        run: (fn, options) => {
          services = options.services;
          return fn();
        },
      },
      loadFreshProgram: async () => ({
        docHelp: { recoverFromFailure: () => services.docs.search("anything") },
      }),
    }
  );
  assert.deepEqual(await fixture.execute(), []);
});

test("relocated icon fixture uses the original shipped icon catalog", async () => {
  const programRoot = path.join(base, "skills/workspace-dev/natlang");
  const suite = relocatedSuite(programRoot);
  const fixture = await suite.fixture.create(
    { input: { args: [{ name: "git", kind: "panel", description: "Git" }] } },
    {
      programRoot,
      runtime: { run: (fn) => fn() },
      loadFreshProgram: async () => ({
        unitIcon: async (_unit, catalog) =>
          catalog.readdir("skills/workspace-dev/assets/icons/brands"),
      }),
    }
  );
  assert.deepEqual(
    await fixture.execute(),
    fs.readdirSync(path.join(programRoot, "../assets/icons/brands"))
  );
});

async function scoreDocumentation(buildResult, expectedSources) {
  const programRoot = path.join(base, "skills/sandbox/help");
  const suite = relocatedSuite(programRoot);
  const testCase = {
    input: { function: "locateDoc", question: "What does this skill do?" },
    expected: { sources: expectedSources },
  };
  let services;
  const fixture = await suite.fixture.create(testCase, {
    programRoot,
    runtime: {
      run: (fn, options) => {
        services = options.services;
        return fn();
      },
    },
    loadFreshProgram: async () => ({ docHelp: () => buildResult(services) }),
  });
  const result = await fixture.execute();
  const outcome = { kind: "returned", value: result };
  const observation = await fixture.observe(result, outcome);
  return { result, observation, metric: await suite.score(testCase, observation, outcome) };
}

const found = (source, quote) => ({ source, section: "Skill", quote, fit: "answers" });

test("documentation scoring rejects a forged quote even when it names the expected source", async () => {
  const source = "skills/sandbox/SKILL.md";
  const { metric, observation } = await scoreDocumentation(
    async (services) => {
      await services.fs.readText(source);
      return {
        found: [found(source, "Fabricated source text that this file has never contained.")],
        tried: [source],
      };
    },
    [source]
  );
  assert.equal(metric.quality, 0);
  assert.equal(metric.gates.grounded, false);
  assert.deepEqual(observation.verifiedPassages, []);
});

test("one expected source cannot hide an extra answer from an unexpected source", async () => {
  const expected = "skills/sandbox/SKILL.md",
    unexpected = "skills/web-research/SKILL.md";
  const { metric } = await scoreDocumentation(
    async (services) => ({
      found: [
        found(expected, (await services.fs.readText(expected)).text.slice(0, 100)),
        found(unexpected, (await services.fs.readText(unexpected)).text.slice(0, 100)),
      ],
      tried: [expected, unexpected],
    }),
    [expected]
  );
  assert.equal(metric.gates.grounded, true);
  assert.equal(metric.gates.expectedSources, false);
  assert.equal(metric.quality, 0);
});

test("the separate reviewer receives passages authenticated against the original Markdown", async () => {
  const source = "skills/sandbox/SKILL.md";
  const { metric, observation, result } = await scoreDocumentation(
    async (services) => ({
      found: [found(source, (await services.fs.readText(source)).text.slice(0, 120))],
      tried: [source],
    }),
    [source]
  );
  assert.equal(metric.quality, 1);
  assert.deepEqual(metric.gates, { completed: true, grounded: true, expectedSources: true });
  assert.deepEqual(observation.verifiedPassages, [{ source, text: result.found[0].quote }]);
});

test("catalog citations are authenticated against the entry returned by the fixture service", async () => {
  const entry = JSON.parse(
    fs.readFileSync(path.join(base, "skills/sandbox/help/catalog.json"), "utf8")
  )[0];
  const source = `docs:${entry.id}`;
  const { metric, observation } = await scoreDocumentation(
    async (services) => {
      const described = await services.docs.describe(entry.id);
      return { found: [found(source, described.description)], tried: [source] };
    },
    [source]
  );
  assert.equal(metric.quality, 1);
  assert.deepEqual(observation.verifiedPassages, [{ source, text: entry.description }]);
});

test("the documentation fixture refuses paths outside its Markdown source inventory", async () => {
  await assert.rejects(
    () => scoreDocumentation(async (services) => services.fs.readText("../AGENTS.md"), []),
    /workspace Markdown file/
  );
});

test("editing a returned catalog entry cannot forge later source evidence", async () => {
  const entry = JSON.parse(
    fs.readFileSync(path.join(base, "skills/sandbox/help/catalog.json"), "utf8")
  )[0];
  const source = `docs:${entry.id}`;
  const { metric, observation } = await scoreDocumentation(
    async (services) => {
      const first = await services.docs.describe(entry.id);
      first.description = "Forged documentation created by editing a returned object.";
      await services.docs.describe(entry.id);
      return { found: [found(source, first.description)], tried: [source] };
    },
    [source]
  );
  assert.equal(metric.gates.grounded, false);
  assert.equal(metric.quality, 0);
  assert.deepEqual(observation.verifiedPassages, []);
});

test("model-list responses isolate both nested fit fields and the original case from model writes", async () => {
  const programRoot = path.join(checkouts.system, "skills/local-models");
  const suite = relocatedSuite(programRoot);
  const testCase = JSON.parse(
    fs.readFileSync(path.join(programRoot, "cases.jsonl"), "utf8").split("\n")[0]
  );
  const original = structuredClone(testCase.input.rows);
  let services;
  const fixture = await suite.fixture.create(testCase, {
    programRoot,
    runtime: {
      run: (fn, options) => {
        services = options.services;
        return fn();
      },
    },
    loadFreshProgram: async () => ({
      localModelReadiness: async () => {
        const first = await services.localModels.listModels();
        first[0].state = "poisoned";
        first[0].fit.fit = "poisoned";
        first.pop();
        return services.localModels.listModels();
      },
    }),
  });
  assert.deepEqual(await fixture.execute(), original);
  assert.deepEqual(testCase.input.rows, original);
});

test("log response writes cannot alter later queries, statistics, or the oracle input", async () => {
  const programRoot = path.join(checkouts.system, "skills/server-logs");
  const suite = relocatedSuite(programRoot);
  const testCase = JSON.parse(
    fs.readFileSync(path.join(programRoot, "cases.jsonl"), "utf8").split("\n")[0]
  );
  const original = structuredClone(testCase.input.recording.records);
  let services;
  const fixture = await suite.fixture.create(testCase, {
    programRoot,
    runtime: {
      run: (fn, options) => {
        services = options.services;
        return fn();
      },
    },
    loadFreshProgram: async () => ({
      briefServerLog: async () => {
        const first = await services.serverLog.tail(1);
        first.records[0].message = "Forged log event.";
        first.records[0].level = "error";
        return { query: await services.serverLog.query(), stats: await services.serverLog.stats() };
      },
    }),
  });
  const result = await fixture.execute();
  assert.deepEqual(result.query.records, original);
  assert.equal(
    result.stats.byLevel.error,
    original.filter((record) => record.level === "error").length
  );
  assert.deepEqual(testCase.input.recording.records, original);
});

test("documentation lookup never searches or reads evaluation-feedback Markdown", async () => {
  const { result } = await scoreDocumentation(async (services) => {
    const search = await services.fs.grep(".*", { maxMatches: 1_000_000 });
    await assert.rejects(
      () => services.fs.readText("skills/sandbox/help/DECOMPOSITION.md"),
      /workspace Markdown file/
    );
    assert.ok(search.matches.some((match) => match.file === "skills/sandbox/EVAL.md"));
    assert.ok(search.matches.every((match) => !match.file.endsWith("/DECOMPOSITION.md")));
    return { found: [], tried: [] };
  }, []);
  assert.deepEqual(result.found, []);
});

/** Load original crisp retrieval helpers with only their real service/semantic boundaries substituted. */
function sourceRetrieval(services, judge, focus) {
  const root = path.join(base, "skills/sandbox/help/docHelp");
  const cache = new Map();
  const load = (file) => {
    if (cache.has(file)) return cache.get(file).exports;
    const { code } = transformSync(fs.readFileSync(file, "utf8"), {
      sourcefile: file,
      loader: "ts",
      format: "cjs",
      target: "es2022",
    });
    const module = { exports: {} };
    cache.set(file, module);
    const imported = (specifier) => {
      if (specifier === "natlang:services") return services;
      if (specifier === "./keywords.nl")
        return {
          default:
            focus ??
            (() => {
              throw new Error("Supply a scripted search policy in retrieval boundary tests.");
            }),
          __esModule: true,
        };
      if (specifier === "./fits.nl") return { default: judge, __esModule: true };
      if (specifier.startsWith("./"))
        return load(path.resolve(path.dirname(file), specifier.replace(/\.js$/, ".ts")));
      return require(specifier);
    };
    new Function("require", "module", "exports", code)(imported, module, module.exports);
    return module.exports;
  };
  return load(path.join(root, "locateDoc.ts")).default;
}

test("the original document world remains searchable beyond the grep result bound", async () => {
  let visited = [];
  const { result, metric } = await scoreDocumentation(
    async (services) => {
      const broad = await services.fs.grep("typecheck|single|panel|before|publish", {
        caseInsensitive: true,
        maxMatches: 1000,
      });
      assert.equal(broad.truncated, true);
      const locate = sourceRetrieval(
        services,
        async (_question, text) => {
          visited.push(text);
          return text.includes("@workspace-extensions/typecheck-service.checkPanel")
            ? "answers"
            : "no";
        },
        async () => ["typecheck a single panel", "check panel before publishing"]
      );
      return locate("How do I typecheck a single panel before I publish it?");
    },
    [
      "skills/workspace-dev/TOOLS.md",
      "skills/workspace-dev/WORKFLOW.md",
      "skills/extensiondev/DEV_LOOP.md",
      "skills/sandbox/EVAL.md",
    ]
  );
  assert.equal(metric.quality, 1, JSON.stringify({ metric, result }));
  assert.ok(result.found.some((entry) => entry.source === "skills/workspace-dev/TOOLS.md"));
  assert.ok(visited.some((text) => text.includes("getBuildReport")));
  assert.ok(visited.length <= 12, `Relevant passage rank required ${visited.length} decisions`);
});

test("retrieval continues after an entire rejected batch and keeps source quotes exact", async () => {
  let judgments = 0;
  const body = Array.from(
    { length: 14 },
    (_, index) =>
      `## Section ${index === 13 ? "zzz" : index}\n\nneedle ${index === 13 ? "actionable instruction" : "unhelpful detail"}`
  ).join("\n\n");
  const services = {
    fs: {
      grep: async () => ({ matches: [{ file: "guide.md" }], truncated: false }),
      readText: async () => ({ text: body, truncated: false, contentHash: "fixed" }),
    },
    docs: { search: async () => [] },
  };
  const locate = sourceRetrieval(
    services,
    async (_question, text) => {
      judgments++;
      return text.includes("actionable instruction") ? "answers" : "no";
    },
    async () => ["needle"]
  );
  const result = await locate("Where is the needle located?");
  assert.ok(judgments > 6);
  assert.equal(result.found.length, 1);
  assert.ok(body.includes(result.found[0].quote));
});

test("documentation read continuation uses line offsets and UTF-8 byte bounds", async () => {
  await scoreDocumentation(async (services) => {
    const file = "skills/workspace-dev/TOOLS.md";
    const first = await services.fs.readText(file, { limit: 2, maxBytes: 1048576 });
    const second = await services.fs.readText(file, {
      offset: first.nextOffset,
      limit: 2,
      maxBytes: 1048576,
    });
    const original = fs.readFileSync(path.join(base, file), "utf8");
    assert.equal(first.nextOffset, 3);
    assert.equal(second.startLine, 3);
    assert.equal(first.text + "\n" + second.text, original.split("\n").slice(0, 4).join("\n"));
    assert.equal(second.contentHash, first.contentHash);
    const tooSmall = await services.fs.readText(file, { maxBytes: 1 });
    assert.equal(tooSmall.firstLineExceedsLimit, true);
    return { found: [], tried: [] };
  }, []);
});

test("retrieval reads every line page before ranking exact section quotes", async () => {
  const pages = ["# Guide\n\nOpening material.", "\n## Answer\n\nneedle actionable instruction"];
  const offsets = [];
  const services = {
    fs: {
      grep: async () => ({ matches: [{ file: "guide.md" }], truncated: false }),
      readText: async (_file, options) => {
        offsets.push(options.offset);
        return options.offset === 1
          ? {
              text: pages[0],
              contentHash: "fixed",
              totalLines: 7,
              startLine: 1,
              truncated: true,
              nextOffset: 4,
            }
          : { text: pages[1], contentHash: "fixed", totalLines: 7, startLine: 4, truncated: false };
      },
    },
    docs: { search: async () => [] },
  };
  const locate = sourceRetrieval(
    services,
    async () => "answers",
    async () => ["needle"]
  );
  const result = await locate("Where is the needle?");
  assert.deepEqual(offsets, [1, 4]);
  assert.ok(result.found[0].quote.includes("actionable instruction"));
  assert.ok(pages.join("\n").includes(result.found[0].quote));
});

test("truncated scoped retrieval resolves recursive directory entries relative to the listed scope", async () => {
  const source = "skills/workspace-dev/TOOLS.md";
  const { result, metric } = await scoreDocumentation(
    async (services) => {
      const entries = await services.fs.readdir("skills/workspace-dev", {
        recursive: true,
        withFileTypes: true,
      });
      assert.ok(entries.some((entry) => entry.name === "TOOLS.md"));
      assert.ok(entries.every((entry) => !entry.name.startsWith("skills/workspace-dev/")));
      const scoped = {
        ...services,
        fs: {
          ...services.fs,
          grep: (pattern, options) => services.fs.grep(pattern, { ...options, maxMatches: 1 }),
        },
      };
      const locate = sourceRetrieval(
        scoped,
        async (_question, text) =>
          text.includes("@workspace-extensions/typecheck-service.checkPanel") ? "answers" : "no",
        async () => ["typecheck", "panel"]
      );
      return locate("How do I typecheck a panel?", { paths: ["skills/workspace-dev"] });
    },
    [source]
  );
  assert.equal(metric.quality, 1);
  assert.ok(result.found.every((entry) => entry.source.startsWith("skills/workspace-dev/")));
});

test("empty search requests fail with a corrective error", async () => {
  const locate = sourceRetrieval(
    { fs: {}, docs: {} },
    async () => "no",
    async () => [" "]
  );
  await assert.rejects(
    () => locate("How do I typecheck a panel?"),
    /nonempty search word or phrase/
  );
});

test("literal multiword search terms execute without a recovered failed action", async () => {
  const text = "# Guide\n\nTypecheck a single panel by obtaining its diagnostic report.";
  const services = {
    fs: {
      grep: async () => ({ matches: [{ file: "guide.md" }], truncated: false }),
      readText: async () => ({ text, truncated: false, contentHash: "fixed" }),
    },
    docs: { search: async () => [] },
  };
  const locate = sourceRetrieval(
    services,
    async () => "answers",
    async () => ["typecheck", "single panel"]
  );
  const result = await locate("How do I typecheck a single panel?");
  assert.equal(result.found.length, 1);
  assert.ok(text.includes(result.found[0].quote));
});

test("a useful search synonym absent from the question reaches its grounded source", async () => {
  const text =
    "# Validation\n\nRun static analysis to find type errors before opening the component.";
  let pattern;
  const services = {
    fs: {
      grep: async (chosen) => {
        pattern = chosen;
        return { matches: [{ file: "guide.md" }], truncated: false };
      },
      readText: async () => ({ text, truncated: false, contentHash: "fixed" }),
    },
    docs: { search: async () => [] },
  };
  const locate = sourceRetrieval(
    services,
    async () => "answers",
    async () => ["static analysis"]
  );
  const result = await locate("How do I typecheck a panel?");
  assert.equal(pattern, "static analysis|static|analysis");
  assert.equal(result.found.length, 1);
  assert.ok(text.includes(result.found[0].quote));
});
