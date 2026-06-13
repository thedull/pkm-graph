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

  test("reports no path for nonexistent node", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("canvas", { timeout: 15000 });

    await page.fill("#path-from", "ZZZ_Does_Not_Exist");
    await page.fill("#path-to",   "AI Alignment");
    await page.keyboard.press("Escape");
    await page.locator("#find-path-btn").click({ force: true });

    await expect(page.locator("#path-result")).toContainText("No path found", { timeout: 10000 });
  });
});
