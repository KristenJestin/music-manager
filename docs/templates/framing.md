# Framing skeleton

What the agent appends to an issue when it moves to **To frame**, exactly these headings, in this order, under the intention that is already there. Nothing is coded before the maintainer has decided the open points and the issue is **Framed**.

```markdown
## Proposal

### Why

<!-- What is missing today and why this issue, now. 3–8 sentences. -->

### What changes

<!-- Bullets: what the user gets, surface by surface. Outcomes, not implementation. -->

### Capabilities

<!-- New: `<capability>`. Modified: `<capability>`. Unchanged but touched: `<capability>`. -->

### Impact

<!-- Packages, migrations, tests, documents to edit. One line each. -->

### Points to decide

<!-- One bullet per point: the options (a), (b), (c) and a recommendation. The maintainer answers in a comment. -->

## Design

- **D<lot>-01 · <title>.** <the decision, its reason, and the alternative set aside>
- **D<lot>-02 · <title>.** …

## Spec · <capability>

### Requirement: <name>

<!-- "Hemera SHALL …" sentences. -->

#### Scenario: <name>

- **WHEN** …
- **THEN** …

<!-- One `## Spec · <capability>` section per capability. Every scenario becomes a test named after it. -->

## Decided

<!-- Filled after the maintainer's comment: one bullet per point, what was decided, on which date. -->
```

Then the **task lists**, one per phase, as GitHub task lists in the issue body (or one comment per phase), each item naming its verification:

```markdown
## Tasks

### Phase 0 · UI first, when the Console changes

- [ ] <screen or component>: the states it can be in, on fixtures; check `bun run check` green
- [ ] Branch pushed, **draft pull request** to `main`, URL in the issue, comment mentioning the maintainer
- [ ] UI gate: the maintainer validates on the pull request's preview deployment and says so in a comment

### Phase 1 · Domain and services

- [ ] <domain rule, resolver, toolbox endpoint>; one test named per scenario of the Spec; check `bun run check` green

### Phase 2 · Wiring and migration

- [ ] <server functions, routes, migration>; end-to-end scenarios; check `bun run e2e` green

### Phase 3 · Acceptance and delivery

- [ ] `bun run check` and `bun run e2e` green, outputs attached to the pull request
- [ ] The result verified in a player (Navidrome, Feishin or Symfonium) when tags or files changed; a screenshot attached
- [ ] Pull request ready (Angular subject, `Closes #<n>`), issue In review
```

Rules that do not bend: a task is ticked only after its verification ran and its output was seen; a scenario without a test is a defect; if a section is wrong, say it in a comment instead of deviating; the maintainer merges, the agent never does.
