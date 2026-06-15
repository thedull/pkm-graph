const { test, expect } = require("@playwright/test");

// ─── API ──────────────────────────────────────────────────────────────────────

test.describe("API endpoints", () => {
  test("/api/graph returns nodes and links", async ({ request }) => {
    const res = await request.get("/api/graph");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.nodes.length).toBeGreaterThan(400);
    expect(body.links.length).toBeGreaterThan(100);

    const n = body.nodes[0];
    expect(n).toHaveProperty("id");
    expect(n).toHaveProperty("title");
    expect(n).toHaveProperty("type");
    expect(n).toHaveProperty("community");
    expect(n).toHaveProperty("betweenness");
    expect(n).toHaveProperty("degree");
  });

  test("/api/graph contains no .graphignore'd junk (node_modules, reports, artifacts)", async ({ request }) => {
    const res = await request.get("/api/graph");
    expect(res.ok()).toBeTruthy();
    const { nodes } = await res.json();
    const junk = nodes.filter(n => n.path && (
      n.path.includes("node_modules") ||
      /Graph Discovery Report/i.test(n.path) ||
      n.path.startsWith("wiki/artifacts/") ||
      n.path === "wiki/ingest-queue.md"
    ));
    expect(junk.map(n => n.path)).toEqual([]);
  });

  test("/api/communities returns community list", async ({ request }) => {
    const res = await request.get("/api/communities");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toHaveProperty("id");
    expect(body[0]).toHaveProperty("size");
    expect(body[0]).toHaveProperty("sample");
  });

  test("/api/suggestions returns candidate pairs", async ({ request }) => {
    const res = await request.get("/api/suggestions");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body)).toBeTruthy();
    if (body.length > 0) {
      expect(body[0]).toHaveProperty("sourceId");
      expect(body[0]).toHaveProperty("targetId");
      expect(body[0]).toHaveProperty("score");
    }
  });

  test("/api/path returns a chain between known nodes", async ({ request }) => {
    const res = await request.get("/api/path?from=Michel%20Foucault&to=AI%20Alignment");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty("chain");
    expect(body.chain.length).toBeGreaterThan(0);
    expect(body.chain[0]).toBe("Michel Foucault");
    expect(body.chain[body.chain.length - 1]).toBe("AI Alignment");
  });

  test("/api/path returns empty chain for unknown nodes", async ({ request }) => {
    const res = await request.get("/api/path?from=ZZZ_Unknown_Node&to=AI%20Alignment");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.chain).toHaveLength(0);
  });

  test("/api/semantic-search returns ranked notes (requires embeddings)", async ({ request }) => {
    const res = await request.get("/api/semantic-search?q=" + encodeURIComponent("the nature of consciousness") + "&k=5");
    test.skip(res.status() === 503, "embeddings / Ollama embed model not available");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.results)).toBeTruthy();
    if (body.results.length) {
      expect(body.results[0]).toHaveProperty("title");
      expect(body.results[0]).toHaveProperty("score");
      expect(body.results[0]).toHaveProperty("neighbors");
    }
  });

  test("/api/chat returns streaming text (requires Ollama)", async ({ request }) => {
    test.skip(!process.env.OLLAMA_AVAILABLE, "Ollama not available");
    const res = await request.post("/api/chat", {
      data: {
        messages: [{ role: "user", content: "What is the most connected node?" }],
        context: { graphStats: { nodes: 100, edges: 50, communities: 5 } },
        provider: "ollama",
      },
    });
    expect(res.ok()).toBeTruthy();
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
  });
});

// ─── Page load ────────────────────────────────────────────────────────────────

test.describe("Page load", () => {
  test("loads without JS errors", async ({ page }) => {
    const errors = [];
    page.on("pageerror", e => {
      // ignore the legacy lights deprecation warning from Three.js — cosmetic only
      if (!e.message.includes("useLegacyLights")) errors.push(e.message);
    });
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });
    expect(errors).toHaveLength(0);
  });

  test("sidebar controls are present", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    await expect(page.locator("#search")).toBeVisible();
    await expect(page.locator("#color-sel")).toBeVisible();
    await expect(page.locator("#size-sel")).toBeVisible();
    await expect(page.locator("#chip-hubs")).toBeVisible();
    await expect(page.locator("#chip-orphans")).toBeVisible();
    await expect(page.locator("#chip-suggestions")).toBeVisible();
    await expect(page.locator("#community-legend")).toBeVisible();
    await expect(page.locator("#find-path-btn")).toBeVisible();
    await expect(page.locator("#copilot-btn")).toBeVisible();
  });
});

// ─── Display controls ─────────────────────────────────────────────────────────

test.describe("Display controls", () => {
  test("color-by select switches value", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    const sel = page.locator("#color-sel");
    await sel.selectOption("type");
    await expect(sel).toHaveValue("type");

    await sel.selectOption("community");
    await expect(sel).toHaveValue("community");
  });

  test("size-by select switches value", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    const sel = page.locator("#size-sel");
    await sel.selectOption("betweenness");
    await expect(sel).toHaveValue("betweenness");
  });

  test("focusing a node dims links outside its neighborhood", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });
    await page.waitForFunction(() => typeof allNodes !== "undefined" && allNodes.length > 0, { timeout: 10000 });

    const dim = await page.evaluate(() => {
      const gn = Graph.graphData().nodes.find(x => x.id === allNodes[10].id) || allNodes[10];
      onNodeClick(gn);
      const links = Graph.graphData().links;
      const has = id => highlightIds.has(id);
      const outside = links.find(l => !(has(l.source.id ?? l.source) && has(l.target.id ?? l.target)));
      const within = links.find(l => has(l.source.id ?? l.source) && has(l.target.id ?? l.target));
      return {
        count: highlightIds.size,
        outsideColor: outside ? Graph.linkColor()(outside) : null,
        outsideWidth: outside ? Graph.linkWidth()(outside) : null,
        withinColor: within ? Graph.linkColor()(within) : null,
      };
    });
    expect(dim.count).toBeGreaterThan(0);
    if (dim.outsideColor) expect(dim.outsideColor).toBe("rgba(70,70,90,0.05)");
    if (dim.outsideWidth != null) expect(dim.outsideWidth).toBe(0.05);
    if (dim.withinColor) expect(dim.withinColor).not.toBe("rgba(70,70,90,0.05)");
  });

  test("hub overlay chip toggles active", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    const chip = page.locator("#chip-hubs");
    await expect(chip).not.toHaveClass(/active/);
    await chip.click();
    await expect(chip).toHaveClass(/active/);
    await chip.click();
    await expect(chip).not.toHaveClass(/active/);
  });

  test("orphan overlay chip toggles active", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    const chip = page.locator("#chip-orphans");
    await chip.click();
    await expect(chip).toHaveClass(/active/);
  });

  test("suggestions overlay loads and updates chip label", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    const chip = page.locator("#chip-suggestions");
    await chip.click();
    await expect(chip).toContainText("Link hints", { timeout: 10000 });
    await expect(chip).toHaveClass(/active/);
  });
});

// ─── Type filters ─────────────────────────────────────────────────────────────

test.describe("Type filters", () => {
  test("clicking a type chip toggles it off", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    const personChip = page.locator("#type-filters .chip[data-type='person']");
    await expect(personChip).toHaveClass(/active/);
    await personChip.click();
    await expect(personChip).not.toHaveClass(/active/);
    await expect(personChip).toHaveClass(/off/);
  });

  test("clicking again re-enables the filter", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    const chip = page.locator("#type-filters .chip[data-type='concept']");
    await chip.click();
    await chip.click();
    await expect(chip).toHaveClass(/active/);
    await expect(chip).not.toHaveClass(/off/);
  });
});

// ─── Community legend ─────────────────────────────────────────────────────────

test.describe("Community legend", () => {
  test("legend loads with community chips", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });
    await expect(page.locator("#community-legend .comm-chip").first()).toBeVisible({ timeout: 10000 });
    const count = await page.locator("#community-legend .comm-chip").count();
    expect(count).toBeGreaterThan(5);
  });

  test("clicking a community chip marks it isolated", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });
    await page.waitForSelector("#community-legend .comm-chip", { timeout: 10000 });

    const first = page.locator("#community-legend .comm-chip").first();
    await first.click();
    await expect(first).toHaveClass(/isolated/);

    await first.click();
    await expect(first).not.toHaveClass(/isolated/);
  });
});

// ─── /api/note endpoint ───────────────────────────────────────────────────────

test.describe("/api/note endpoint", () => {
  test("returns 400 when path is missing", async ({ request }) => {
    const res = await request.get("/api/note");
    expect(res.status()).toBe(400);
  });

  test("returns 404 for a nonexistent file", async ({ request }) => {
    const res = await request.get("/api/note?path=wiki/does-not-exist-zzz.md");
    expect(res.status()).toBe(404);
  });

  test("returns 403 for a path-traversal attempt", async ({ request }) => {
    const res = await request.get("/api/note?path=../../etc/passwd");
    expect(res.status()).toBe(403);
  });

  test("returns note content for a valid path", async ({ request }) => {
    const graph = await request.get("/api/graph");
    const { nodes } = await graph.json();
    const nodeWithPath = nodes.find(n => n.path && n.path.endsWith(".md"));
    if (!nodeWithPath) return;

    const res = await request.get(`/api/note?path=${encodeURIComponent(nodeWithPath.path)}`);
    expect(res.ok()).toBeTruthy();
    const note = await res.json();
    expect(note).toHaveProperty("title");
    expect(note).toHaveProperty("type");
    expect(note).toHaveProperty("body");
  });
});

// ─── Node Detail Panel ────────────────────────────────────────────────────────

test.describe("Node detail panel", () => {
  test("panel is hidden on initial load", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });
    await expect(page.locator("#node-detail-panel")).not.toHaveClass(/open/);
  });

  test("close button hides the panel", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    await page.evaluate(() => document.getElementById("node-detail-panel").classList.add("open"));
    await expect(page.locator("#node-detail-panel")).toHaveClass(/open/);

    await page.click("#ndp-close");
    await expect(page.locator("#node-detail-panel")).not.toHaveClass(/open/);
  });

  test("wikilink opens the node panel without touching the search box", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });
    await page.waitForFunction(() => typeof allNodes !== "undefined" && allNodes.length > 0, { timeout: 10000 });

    await page.fill("#search", "preexisting search text");
    const title = await page.evaluate(() => allNodes[0].title);
    await page.evaluate(t => window.openNoteFromWikilink(t), title);

    await expect(page.locator("#node-detail-panel")).toHaveClass(/open/);
    await expect(page.locator("#ndp-title")).not.toBeEmpty();
    // search box is left untouched
    await expect(page.locator("#search")).toHaveValue("preexisting search text");
  });

  test("Escape key hides the panel", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    await page.evaluate(() => document.getElementById("node-detail-panel").classList.add("open"));
    await expect(page.locator("#node-detail-panel")).toHaveClass(/open/);

    await page.keyboard.press("Escape");
    await expect(page.locator("#node-detail-panel")).not.toHaveClass(/open/);
  });

  test("showNodeDetailPanel loads and renders note content", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    const nodes = await page.evaluate(async () => {
      const res = await fetch("/api/graph");
      const { nodes } = await res.json();
      return nodes.filter(n => n.path && n.path.endsWith(".md")).slice(0, 3);
    });

    if (!nodes.length) return;

    await page.evaluate(node => {
      window.showNodeDetailPanel(node);
    }, nodes[0]);

    await expect(page.locator("#node-detail-panel")).toHaveClass(/open/, { timeout: 5000 });
    await expect(page.locator("#ndp-title")).not.toBeEmpty({ timeout: 8000 });

    await expect(page.locator("#ndp-body")).not.toContainText("Loading…", { timeout: 8000 });
    await expect(page.locator("#ndp-obsidian")).toHaveAttribute("href", /obsidian:\/\//);
  });
});

// ─── Search clear button ──────────────────────────────────────────────────────

test.describe("Search clear button", () => {
  test("clear button appears when input has text", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    const clearBtn = page.locator("#search-clear");
    await expect(clearBtn).toBeHidden();

    await page.fill("#search", "Foucault");
    await expect(clearBtn).toBeVisible();
  });

  test("clicking clear button empties the input", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    await page.fill("#search", "Foucault");
    await page.click("#search-clear");
    await expect(page.locator("#search")).toHaveValue("");
    await expect(page.locator("#search-clear")).toBeHidden();
  });

  test("path-from clear button works", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    await page.fill("#path-from", "Test");
    await expect(page.locator("#path-from-clear")).toBeVisible();
    await page.click("#path-from-clear");
    await expect(page.locator("#path-from")).toHaveValue("");
  });
});

// ─── Diacritics normalization ─────────────────────────────────────────────────

test.describe("Diacritics normalization", () => {
  test("search matches titles with diacritics when typed without them", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });
    // wait for nodes to load
    await page.waitForFunction(() => typeof allNodes !== "undefined" && allNodes.length > 0, { timeout: 10000 });

    const hasDiacriticNodes = await page.evaluate(() =>
      allNodes.some(n => n.title && /[^ -]/.test(n.title))
    );
    test.skip(!hasDiacriticNodes, "No nodes with diacritics in this vault");

    // find a node with a diacritic and strip it for the search
    const sampleTitle = await page.evaluate(() =>
      allNodes.find(n => n.title && /[^ -]/.test(n.title))?.title || ""
    );
    const stripped = sampleTitle.normalize("NFD").replace(/[̀-ͯ]/g, "").slice(0, 5);
    await page.fill("#search", stripped);
    await expect(page.locator("#search-ac")).toHaveClass(/open/, { timeout: 3000 });
    await expect(page.locator("#search-ac")).toContainText(sampleTitle.slice(0, 5));
  });
});

// ─── Copilot panel ────────────────────────────────────────────────────────────

test.describe("Copilot panel", () => {
  test("panel is hidden on initial load", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });
    await expect(page.locator("#copilot-panel")).not.toHaveClass(/open/);
  });

  test("copilot-btn opens and closes the panel", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    await page.click("#copilot-btn");
    await expect(page.locator("#copilot-panel")).toHaveClass(/open/);
    await expect(page.locator("#copilot-btn")).toHaveClass(/cop-active/);

    await page.click("#cop-close");
    await expect(page.locator("#copilot-panel")).not.toHaveClass(/open/);
    await expect(page.locator("#copilot-btn")).not.toHaveClass(/cop-active/);
  });

  test("Escape key closes the copilot panel", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    await page.click("#copilot-btn");
    await expect(page.locator("#copilot-panel")).toHaveClass(/open/);

    await page.keyboard.press("Escape");
    await expect(page.locator("#copilot-panel")).not.toHaveClass(/open/);
  });

  test("provider toggle switches active button", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });
    await page.click("#copilot-btn");

    const localBtn = page.locator(".cop-prov-btn[data-provider='ollama']");
    const cloudBtn = page.locator(".cop-prov-btn[data-provider='openrouter']");

    await expect(localBtn).toHaveClass(/active/);
    await cloudBtn.click();
    await expect(cloudBtn).toHaveClass(/active/);
    await expect(localBtn).not.toHaveClass(/active/);
  });

  test("shows a disconnection message when the model is unreachable", async ({ page }) => {
    // simulate the chat endpoint being unreachable
    await page.route("**/api/chat", route => route.abort());
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    await page.click("#copilot-btn");
    await page.fill("#cop-input", "hello");
    await page.click("#cop-send");

    const err = page.locator(".cop-msg-error");
    await expect(err).toBeVisible({ timeout: 10000 });
    await expect(err).toContainText(/couldn't reach|cannot reach/i);
  });

  test("executes an ACTIONS directive from the model", async ({ page }) => {
    // stub the model response with prose + an ACTIONS line driving the graph
    await page.route("**/api/chat", route => route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: 'Switching the colour mode for you.\n' +
            'ACTIONS: [{"action":"setColorMode","args":{"mode":"type"}}]\n' +
            'SUGGESTIONS: ["What do the colours mean?"]',
    }));
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    await page.click("#copilot-btn");
    await page.fill("#cop-input", "color by type");
    await page.click("#cop-send");

    // the directive should flip the color-by control and leave a tool-run summary
    await expect(page.locator("#color-sel")).toHaveValue("type", { timeout: 10000 });
    await expect(page.locator(".cop-tools-toggle")).toContainText("Ran 1 tool");
    await expect(page.locator(".cop-tool-row")).toContainText("Color by type");
  });

  test("findPath action resolves fuzzy titles and isolates the path", async ({ page }) => {
    // model supplies lowercase / un-accented titles; the client should resolve them
    await page.route("**/api/chat", route => route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: 'Tracing the connection.\n' +
            'ACTIONS: [{"action":"findPath","args":{"from":"michel foucault","to":"ai alignment"}}]\n' +
            'SUGGESTIONS: []',
    }));
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    await page.click("#copilot-btn");
    await page.fill("#cop-input", "connect foucault and alignment");
    await page.click("#cop-send");

    await expect(page.locator(".cop-tool-row")).toContainText("Find path", { timeout: 10000 });
    await expect(page.locator("#find-path-btn")).toHaveText("Reset path");
  });

  test("findPath action reports a node that isn't in the graph", async ({ page }) => {
    await page.route("**/api/chat", route => route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: 'Let me check.\n' +
            'ACTIONS: [{"action":"findPath","args":{"from":"ZZZ Not A Real Node","to":"AI Alignment"}}]\n' +
            'SUGGESTIONS: []',
    }));
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    await page.click("#copilot-btn");
    await page.fill("#cop-input", "path from a fake node");
    await page.click("#cop-send");

    // the run is summarized as failed, and the detail names the missing node
    await expect(page.locator(".cop-tools.has-fail .cop-tools-toggle")).toContainText("failed", { timeout: 10000 });
    const row = page.locator(".cop-tool-row.fail");
    await expect(row).toContainText("Couldn't find");
    await expect(row).toContainText("ZZZ Not A Real Node");
  });

  test("parses suggestion chips even when the model wraps the label in markdown", async ({ page }) => {
    // small models often emit "**SUGGESTIONS:**" or similar instead of the bare label
    await page.route("**/api/chat", route => route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: 'Community 0 is dense.\n\n**SUGGESTIONS:** ["Isolate Community 0", "Find its hubs", "Check central concepts"]',
    }));
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    await page.click("#copilot-btn");
    await page.fill("#cop-input", "tell me about community 0");
    await page.click("#cop-send");

    // chips render, and the raw sentinel never leaks into the message bubble
    await expect(page.locator("#cop-suggestions .cop-sug-chip")).toHaveCount(3, { timeout: 10000 });
    await expect(page.locator("#cop-messages")).not.toContainText("SUGGESTIONS");
  });

  test("chat request carries graph-grounded retrieval context", async ({ page }) => {
    let captured = null;
    await page.route("**/api/chat", async route => {
      captured = route.request().postDataJSON();
      await route.fulfill({ status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "ok\nSUGGESTIONS: []" });
    });
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });
    await page.waitForFunction(() => typeof allNodes !== "undefined" && allNodes.length > 0, { timeout: 10000 });

    const title = await page.evaluate(() => allNodes[0].title);
    await page.click("#copilot-btn");
    await page.fill("#cop-input", "Tell me about " + title);
    await page.click("#cop-send");

    await expect.poll(() => (captured && Array.isArray(captured.context?.retrieval)) ? captured.context.retrieval.length : 0,
      { timeout: 10000 }).toBeGreaterThan(0);
    expect(captured.context.retrieval.map(r => r.title)).toContain(title);
    // retrieval entries carry compact graph facts for grounding
    expect(captured.context.retrieval[0]).toHaveProperty("neighbors");
    expect(captured.context.retrieval[0]).toHaveProperty("path");
  });

  test("provider buttons show icons and assistant messages carry a provider badge", async ({ page }) => {
    await page.route("**/api/chat", route => route.fulfill({
      status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: "Hello from the cloud.\nSUGGESTIONS: []",
    }));
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });
    await page.click("#copilot-btn");

    // both provider toggles render an inline SVG icon
    await expect(page.locator('.cop-prov-btn[data-provider="ollama"] .cop-prov-ic svg')).toHaveCount(1);
    await expect(page.locator('.cop-prov-btn[data-provider="openrouter"] .cop-prov-ic svg')).toHaveCount(1);

    // pick Cloud, send a message, assistant bubble shows a Cloud badge + icon
    await page.click('.cop-prov-btn[data-provider="openrouter"]');
    await page.fill("#cop-input", "hi");
    await page.click("#cop-send");
    const role = page.locator(".cop-msg.assistant .cop-msg-role").last();
    await expect(role).toContainText("Cloud", { timeout: 10000 });
    await expect(role.locator(".cop-prov-icon svg")).toHaveCount(1);
  });

  test("Ask Copilot button opens the Copilot and keeps the node panel open", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });
    const node = await page.evaluate(async () => {
      const res = await fetch("/api/graph"); const { nodes } = await res.json();
      return nodes.find(n => n.path && n.path.endsWith(".md")) || nodes[0];
    });
    await page.evaluate(n => window.showNodeDetailPanel(n), node);
    await expect(page.locator("#ndp-ask")).toBeVisible();
    await page.click("#ndp-ask");
    await expect(page.locator("#copilot-panel")).toHaveClass(/open/);
    await expect(page.locator("#node-detail-panel")).toHaveClass(/open/);
    await expect(page.locator("#cop-input")).not.toHaveValue("");
  });

  test("@-mention opens a node picker and inserts the title", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });
    await page.waitForFunction(() => typeof allNodes !== "undefined" && allNodes.length > 0, { timeout: 10000 });
    await page.click("#copilot-btn");

    // type "@" plus the first 4 letters of a real node title
    const partial = await page.evaluate(() => allNodes[0].title.normalize("NFD").replace(/[̀-ͯ]/g, "").slice(0, 4));
    const fullTitle = await page.evaluate(() => allNodes[0].title);
    await page.fill("#cop-input", "compare @" + partial);
    // trigger input handler at the caret
    await page.locator("#cop-input").press("End");
    await page.locator("#cop-input").type("");
    await page.evaluate(() => { const e = document.getElementById("cop-input"); e.setSelectionRange(e.value.length, e.value.length); updateMentionDropdown(); });

    await expect(page.locator("#mention-drop")).toHaveClass(/open/);
    await page.locator("#mention-drop .ac-item").first().click();
    // the @token is replaced with the resolved node title and it's pinned
    await expect(page.locator("#cop-input")).toHaveValue(new RegExp(fullTitle.slice(0, 6).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    expect(await page.evaluate(() => mentionNodes.length)).toBeGreaterThan(0);
  });

  test("isolating a community feeds it to the Copilot context", async ({ page }) => {
    let captured = null;
    await page.route("**/api/chat", async route => {
      captured = route.request().postDataJSON();
      await route.fulfill({ status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "ok\nSUGGESTIONS: []" });
    });
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });
    await page.waitForSelector("#community-legend .comm-chip", { timeout: 10000 });

    // isolate the first community, then ask about it with no node selected
    await page.locator("#community-legend .comm-chip").first().click();
    await page.click("#copilot-btn");
    await page.fill("#cop-input", "what is this community about");
    await page.click("#cop-send");

    await expect.poll(() => captured?.context?.isolatedCommunity?.id, { timeout: 10000 }).not.toBeUndefined();
    expect(captured.context.isolatedCommunity).not.toBeNull();
    expect(Array.isArray(captured.context.isolatedCommunity.sample)).toBeTruthy();
    expect(captured.context.viewMode).toBe("community");
  });

  test("an isolated path is sent to the Copilot as highlightedNodes", async ({ page }) => {
    let captured = null;
    await page.route("**/api/chat", async route => {
      captured = route.request().postDataJSON();
      await route.fulfill({ status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "ok\nSUGGESTIONS: []" });
    });
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    // isolate a real path
    await page.fill("#path-from", "Michel Foucault");
    await page.fill("#path-to", "AI Alignment");
    await page.keyboard.press("Escape");
    await page.locator("#find-path-btn").click({ force: true });
    await expect(page.locator("#find-path-btn")).toHaveText("Reset path", { timeout: 15000 });

    await page.click("#copilot-btn");
    await page.fill("#cop-input", "how do the highlighted nodes relate?");
    await page.click("#cop-send");

    await expect.poll(() => captured?.context?.highlightedNodes?.length || 0, { timeout: 10000 }).toBeGreaterThan(0);
    expect(captured.context.highlightedNodes).toContain("Michel Foucault");
    expect(captured.context.highlightedNodes).toContain("AI Alignment");
  });

  test("a malformed ACTIONS line never leaks into the message prose", async ({ page }) => {
    // model emits a bad object (not array) with an invented action name
    await page.route("**/api/chat", route => route.fulfill({
      status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: 'Here is the analysis of the cluster.\nACTIONS: {"action": "explore related concepts"}\nSUGGESTIONS: ["Show me the hubs"]',
    }));
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });
    await page.click("#copilot-btn");
    await page.fill("#cop-input", "tell me about the cluster");
    await page.click("#cop-send");

    const msg = page.locator(".cop-msg.assistant .cop-msg-text").last();
    await expect(msg).toContainText("analysis of the cluster", { timeout: 10000 });
    await expect(page.locator("#cop-messages")).not.toContainText("ACTIONS");
    await expect(page.locator("#cop-messages")).not.toContainText("explore related concepts");
    // invalid action is dropped → no tool-run group
    await expect(page.locator(".cop-tools")).toHaveCount(0);
    // suggestions still parse
    await expect(page.locator("#cop-suggestions .cop-sug-chip")).toHaveCount(1);
  });

  test("Stop button cancels an in-flight reply", async ({ page }) => {
    // slow response so we can interrupt it
    await page.route("**/api/chat", async route => {
      await new Promise(r => setTimeout(r, 4000));
      try { await route.fulfill({ status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "late\nSUGGESTIONS: []" }); } catch (_) {}
    });
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });
    await page.click("#copilot-btn");
    await page.fill("#cop-input", "hello");
    await page.click("#cop-send");

    // button switches to Stop while streaming
    await expect(page.locator("#cop-send")).toHaveClass(/stop/, { timeout: 5000 });
    // press Stop
    await page.click("#cop-send");
    await expect(page.locator("#cop-send")).not.toHaveClass(/stop/);
    await expect(page.locator(".cop-note")).toContainText("Stopped", { timeout: 5000 });
  });

  test("an empty model reply shows feedback instead of a silent blank bubble", async ({ page }) => {
    // model returns no prose (only a suggestions line) — must not look like a hang
    await page.route("**/api/chat", route => route.fulfill({
      status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: 'SUGGESTIONS: ["Show me the communities"]',
    }));
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });
    await page.click("#copilot-btn");
    await page.fill("#cop-input", "hi");
    await page.click("#cop-send");

    // explicit note appears; no empty assistant bubble lingers; suggestion still renders
    await expect(page.locator(".cop-note")).toContainText("No reply text returned", { timeout: 10000 });
    await expect(page.locator(".cop-msg.assistant")).toHaveCount(0);
    await expect(page.locator("#cop-suggestions .cop-sug-chip")).toHaveCount(1);
  });

  test("chat input shows a scrollbar only when overflowing", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });
    await page.click("#copilot-btn");

    const ta = page.locator("#cop-input");
    await ta.fill("one short line");
    expect(await ta.evaluate(e => getComputedStyle(e).overflowY)).toBe("hidden");

    await ta.fill(Array.from({ length: 25 }, (_, i) => "line " + i).join("\n"));
    await ta.evaluate(e => e.dispatchEvent(new Event("input")));
    expect(await ta.evaluate(e => getComputedStyle(e).overflowY)).toBe("auto");
  });
});

// ─── Layout & responsiveness ──────────────────────────────────────────────────

test.describe("Layout & responsiveness", () => {
  test("graph canvas tracks the viewport width on resize", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });
    const w1 = await page.locator("canvas").first().evaluate(c => c.clientWidth);

    await page.setViewportSize({ width: 760, height: 800 });
    await page.waitForTimeout(400);
    const w2 = await page.locator("canvas").first().evaluate(c => c.clientWidth);

    expect(w1).toBeGreaterThan(1000);
    expect(w2).toBeLessThan(w1);
  });

  test("Node panel (left) and Copilot (right) open independently; no rail tabs", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    // the tabbed rail is gone
    await expect(page.locator("#rail-tabs")).toHaveCount(0);

    // open the node detail panel via its API
    const node = await page.evaluate(async () => {
      const res = await fetch("/api/graph"); const { nodes } = await res.json();
      return nodes.find(n => n.path && n.path.endsWith(".md")) || nodes[0];
    });
    await page.evaluate(n => window.showNodeDetailPanel(n), node);
    await page.click("#copilot-btn");

    // both visible at once
    await expect(page.locator("#node-detail-panel")).toHaveClass(/open/);
    await expect(page.locator("#copilot-panel")).toHaveClass(/open/);

    // node panel docks to the right of the sidebar (left edge ≈ sidebar width)
    const left = await page.locator("#node-detail-panel").evaluate(e => e.getBoundingClientRect().left);
    const sidebarW = await page.locator("#sidebar").evaluate(e => e.offsetWidth);
    expect(Math.abs(left - sidebarW)).toBeLessThan(3);

    // Esc closes both
    await page.keyboard.press("Escape");
    await expect(page.locator("#node-detail-panel")).not.toHaveClass(/open/);
    await expect(page.locator("#copilot-panel")).not.toHaveClass(/open/);
  });
});

// ─── Path isolation ───────────────────────────────────────────────────────────

test.describe("Path isolation", () => {
  test("find path button toggles to Reset path after a path is found", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    await page.fill("#path-from", "Michel Foucault");
    await page.fill("#path-to",   "AI Alignment");
    await page.keyboard.press("Escape");
    await page.locator("#find-path-btn").click({ force: true });

    await expect(page.locator("#path-result")).not.toHaveText("Finding path…", { timeout: 10000 });
    await expect(page.locator("#find-path-btn")).toHaveText("Reset path");
    await expect(page.locator("#find-path-btn")).toHaveClass(/path-reset-mode/);
  });

  test("clicking Reset path restores full graph", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    await page.fill("#path-from", "Michel Foucault");
    await page.fill("#path-to",   "AI Alignment");
    await page.keyboard.press("Escape");
    await page.locator("#find-path-btn").click({ force: true });
    await expect(page.locator("#find-path-btn")).toHaveText("Reset path", { timeout: 10000 });

    await page.locator("#find-path-btn").click({ force: true });
    await expect(page.locator("#find-path-btn")).toHaveText("Find path");
    await expect(page.locator("#find-path-btn")).not.toHaveClass(/path-reset-mode/);
  });
});

// ─── Pathfinding ─────────────────────────────────────────────────────────────

test.describe("Pathfinding panel", () => {
  test("returns a path for known thinkers", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    await page.fill("#path-from", "Michel Foucault");
    await page.fill("#path-to",   "AI Alignment");
    await page.keyboard.press("Escape");
    await page.locator("#find-path-btn").click({ force: true });

    const result = page.locator("#path-result");
    await expect(result).not.toHaveText("Finding path…", { timeout: 10000 });
    await expect(result).toContainText("Michel Foucault");
    await expect(result).toContainText("AI Alignment");
  });

  test("add/remove extra node rows", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    await page.click("#path-add-node");
    await expect(page.locator("#path-extra .path-node-row")).toHaveCount(1);
    await page.click("#path-add-node");
    await expect(page.locator("#path-extra .path-node-row")).toHaveCount(2);
    await page.locator("#path-extra .path-node-remove").first().click();
    await expect(page.locator("#path-extra .path-node-row")).toHaveCount(1);
  });

  test("Reset path clears the inputs and removes extra rows", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    await page.click("#path-add-node");
    await page.fill("#path-from", "Michel Foucault");
    await page.fill("#path-to", "AI Alignment");
    await page.fill("#path-extra .path-node-input", "Friedrich Nietzsche");
    await page.keyboard.press("Escape");
    await page.locator("#find-path-btn").click({ force: true });
    await expect(page.locator("#find-path-btn")).toHaveText("Reset path", { timeout: 15000 });

    await page.locator("#find-path-btn").click({ force: true });
    await expect(page.locator("#path-from")).toHaveValue("");
    await expect(page.locator("#path-to")).toHaveValue("");
    await expect(page.locator("#path-extra .path-node-row")).toHaveCount(0);
    await expect(page.locator("#find-path-btn")).toHaveText("Find path");
  });

  test("connects 3 nodes via pairwise paths", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    await page.click("#path-add-node");
    await page.fill("#path-from", "Michel Foucault");
    await page.fill("#path-to", "AI Alignment");
    await page.fill("#path-extra .path-node-input", "Friedrich Nietzsche");
    await page.keyboard.press("Escape");
    await page.locator("#find-path-btn").click({ force: true });

    await expect(page.locator("#path-result")).toContainText("Connected", { timeout: 15000 });
    await expect(page.locator("#find-path-btn")).toHaveText("Reset path");
  });

  test("reports a missing node when the endpoint isn't in the graph", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    await page.fill("#path-from", "ZZZ_Does_Not_Exist");
    await page.fill("#path-to",   "AI Alignment");
    await page.keyboard.press("Escape");
    await page.locator("#find-path-btn").click({ force: true });

    // title resolution can't find the node, so it reports that rather than "no path"
    await expect(page.locator("#path-result")).toContainText("No node found", { timeout: 10000 });
  });
});
