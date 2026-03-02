# Feature Diff: Legacy Projects vs Luna Hub Lite Spec

What changed from a user's perspective when the three legacy projects were consolidated into Luna Hub Lite.

---

# Luna Hub

Legacy Luna Hub was a self-hosted platform you installed on your own server. Luna Hub Lite is a hosted web app at `lunahub.dev`.

## Removed

- **Built-in AI chat agent** — Legacy had its own AI agent you could talk to directly in the Hub. Gone. You now bring your own AI client (Claude Desktop, Cursor, etc.) and connect via MCP.
- **Agent presets** — You could create custom agent personas with different tool access. Gone with the built-in agent.
- **Memories** — Persistent notes the AI would remember across conversations. Gone with the built-in agent.
- **Task flows** — Chains of prompts that ran automatically in sequence (e.g., "morning routine" flow). Gone.
- **Extension store** — Browse, install, and update extensions from GitHub URLs or ZIP uploads. Extensions are now fixed — you can't add your own at launch.
- **Extension UIs** — Extensions could have their own web interfaces embedded in the Hub. Extensions are now tool-only with no UI.
- **Infrastructure management** — Install and manage Docker services (databases, etc.) from the Hub UI. No more self-hosted infrastructure.
- **Remote MCP servers** — Connect to external MCP servers (Smithery) and use their tools alongside local ones. Deferred to post-MVP.
- **Multiple MCP server instances** — Create several MCP endpoints with different tool sets. Now there's exactly one MCP endpoint.
- **System dashboard** — Overview of running services, health status, process monitoring. No services to monitor anymore.
- **Queue manager** — Batch extension operations with retry logic. No dynamic extension management.
- **Environment variable manager** — UI for managing `.env` keys, bulk upload, required secrets highlighting. Replaced by extension credential forms.
- **GitHub login** — Replaced by email/password.

## Added

- **Email/password accounts** — Standard registration and login instead of GitHub OAuth.
- **App activation** — Explicitly turn on CoachByte or ChefByte. Deactivation wipes your data in that module and you start fresh if you reactivate.
- **User-generated MCP API keys** — Generate your own API keys for connecting AI clients. See the key once, copy it, it's hashed after that. Revoke and regenerate anytime.
- **Tool toggles** — Enable/disable individual MCP tools from a list. Only the tools you want are exposed to your AI client.
- **Shared profile settings** — Set your timezone and day start hour once, and it applies across CoachByte and ChefByte.
- **Multi-user support** — Multiple people can have accounts. Your data is isolated from everyone else's.
- **Offline indicator** — Clear "you're offline" state in the UI with disabled buttons and last-synced timestamps.

## Changed

- **Extension credentials** — Instead of editing `.env` files, you enter API keys for Obsidian/Todoist/Home Assistant in a settings form.
- **MCP connection** — Instead of a local MCP server on your machine, you connect to `mcp.lunahub.dev` from any MCP client.

---

# CoachByte

Legacy CoachByte was an extension you installed into Luna Hub. Now it's a built-in app module at `lunahub.dev/coach`.

## Removed

- **In-app chat** — Legacy had a chat sidebar for talking to the AI while working out. Gone — use your external AI client instead.
- **Demo data** — Legacy could populate sample workouts for testing. Not available.

## Added

- **Timer pause/resume** — Legacy timer could only be started and checked. Now you can pause and resume it.
- **Day cleanup** — Empty days (no completed sets) are automatically deleted when you start the next day. Keeps history clean.
- **Configurable day boundary** — Set when your "day" starts (e.g., 6 AM). A 2 AM workout counts as the previous day.
- **Locked-in planned weights** — When today's plan is created from your split template, percentage-based loads are calculated once using your current PRs and saved. They don't shift mid-workout if you hit a new PR.
- **PR alerts** — Get notified when you log a new personal record.
- **History pagination** — Browse past workouts in pages instead of loading everything at once.
- **History filtering** — Filter workout history by exercise.
- **Offline indicator** — Buttons disable when you lose connection, with a "no connection" banner.
- **Real-time sync** — Complete a set via your AI client and the UI updates instantly (no more 5-second polling delay).

## Changed

- **Split planner** — Legacy had two separate but nearly identical edit views. Now it's one unified planner.
- **Weight plate calculator** — Legacy calculated plates for you automatically. Now there's a settings tab where you input what plates you have available, and those are used in the calculation.
- **Set completion order** — Legacy let you pick which set to complete. Now sets are completed strictly in order (the database enforces this).
- **Accessing CoachByte** — Instead of installing an extension into your self-hosted Hub, you activate it with one click at `lunahub.dev/hub`.

---

# ChefByte

Legacy ChefByte was a standalone app deployed on Vercel. Now it's a built-in app module at `lunahub.dev/chef`.

## Removed

- **Import/Export** — Legacy could export all your data to JSON and import it back. Not available.
- **Demo mode** — Legacy had a "Try Demo" button that loaded sample data. Not available.
- **Recipe Finder as a separate page** — Legacy had a dedicated page with density percentile sliders and time filters. Those filters are rolled into the main Recipes view.

## Added

- **Consume without logging macros (scanner mode)** — Legacy could consume from inventory without macros, but only from the inventory page. Now there's a dedicated scanner mode for it — scan a barcode to discard or give away without affecting your daily macros.
- **Barcode scan daily limit** — 100 AI-analyzed scans per day. After that you enter products manually.
- **Macro tracking via MCP tools** — Your AI client can check your macros, log temp items, consume products, manage meal plans, and inspect lot-level inventory — 19 tools total. Legacy ChefByte had no MCP integration at all.
- **Offline indicator** — Buttons disable when offline with a connection status banner.
- **Configurable day boundary** — Same as CoachByte — set when your nutrition "day" starts (e.g., 6 AM so a midnight snack counts toward the previous day).

## Changed

- **Barcode AI** — Switched from GPT-4 to Claude Haiku 4.5 for product name normalization and nutrition extraction.
- **Walmart workflow** — Legacy had single sequential SerpAPI searches. Same approach, but now with explicit per-user rate limiting and manual price refresh instead of ad-hoc calls.
- **Unit system** — Legacy had 4 configurable unit types per product (stock, purchase, consume, price) with conversion tables between them. Now stock is canonical in containers, display defaults to containers, and write operations can be entered in containers or servings (servings are converted server-side via `servings_per_container`).
- **Shopping list auto-fill** — Same concept and same button-triggered approach. Now also includes meal plan → cart sync (scan next 7 days, subtract inventory, round up to whole containers).
- **Meal prep execution** — Same concept (`[MEAL]` inventory) but now prep creates lot-based `[MEAL]` stock with explicit naming (`[MEAL] Recipe Name MM-DD`) and frozen nutrition snapshots. Recipe changes after prep don't affect existing meal lots.
- **Recipe create/edit flow** — Create and edit now use a single shared page in different modes, not separate screens.
- **Recipe macro calculation** — Legacy had a batch job you triggered to recalculate all recipe nutrition. Now recipe macros are computed on the fly — always up to date, no manual trigger needed.
- **Meal lot creation** — Legacy had a batch automation job to create `[MEAL]` items. Now meal lots are created inline when you execute a meal prep entry.
- **Accessing ChefByte** — Instead of a standalone app at its own URL, it's a module at `lunahub.dev/chef` sharing auth and profile with the rest of Luna Hub Lite.
