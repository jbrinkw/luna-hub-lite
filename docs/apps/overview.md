# App Modules Overview

## App Modules vs Extensions

| Aspect                  | App Modules                   | Extensions                     |
| ----------------------- | ----------------------------- | ------------------------------ |
| Has UI pages            | Yes (within single app shell) | No                             |
| Has database schema     | Yes (own Supabase schema)     | No                             |
| Has edge functions      | Optional                      | No                             |
| Has MCP tools           | Yes                           | Yes                            |
| User-facing credentials | N/A (uses hub auth)           | Per-user in Supabase Vault     |
| Deployment              | Part of web app (Vercel)      | Bundled into MCP server Worker |

## Cross-App Integration

### Current Behavior

Cross-app data is accessible through MCP tools only. An AI agent connected via MCP can query both CoachByte and ChefByte tools in the same conversation. Each tool call is its own transaction — if a ChefByte tool fails after a CoachByte tool succeeds, there is no cross-app rollback. The AI agent is responsible for handling partial failures.

Both modules share the `day_start_hour` from the hub profile, ensuring consistent day boundaries. Changes to `day_start_hour` propagate to open modules via Realtime subscription on `hub.profiles`.

### Future Behavior

CoachByte's UI may optionally display today's macros from ChefByte. ChefByte may optionally display recent workout volume from CoachByte. When these features are needed, cross-schema SECURITY DEFINER functions will be added at that time.

## Mobile & Native Readiness

### MVP: Desktop-First Web App

The MVP targets desktop browsers. All UI layouts are designed desktop-first with responsive stacking for narrower viewports. Tailwind CSS is used for styling with Capacitor compatibility preserved for future native builds.

### Post-MVP: Mobile & Native

The following are deferred to post-MVP and designed to be easy to add without rewriting app code:

| Capability         | MVP (Desktop Web)                            | Post-MVP (Mobile / Capacitor)                                                 |
| ------------------ | -------------------------------------------- | ----------------------------------------------------------------------------- |
| Layout             | Desktop-first responsive, multi-column       | Mobile-optimized single-column layouts, bottom tab navigation, swipe gestures |
| Notifications      | Not available                                | `@capacitor/local-notifications` — schedule OS-level timer alerts             |
| Barcode Scanner    | Physical Bluetooth/USB barcode scanner input | `@capacitor/barcode-scanner` for camera scanning                              |
| Haptics            | Not available                                | `@capacitor/haptics`                                                          |
| Storage            | Browser localStorage/IndexedDB               | `@capacitor/preferences`                                                      |
| Background Timer   | Timer recovers on tab/window focus           | True background countdown with native notification on expiry                  |
| Platform Detection | `Capacitor.isNativePlatform()` returns false | Returns true, enables native code paths                                       |
| Distribution       | Web only (lunahub.dev)                       | App Store / Play Store via Capacitor                                          |

### What Post-MVP Unlocks

Background rest timer notifications (CoachByte's biggest web limitation), reliable push notifications, native barcode scanning via camera, HealthKit/Google Fit integration, App Store/Play Store distribution, native share sheet, biometric auth.

### What Doesn't Change

All React components, routing, state management, Supabase queries, Realtime subscriptions, edge functions, and database functions remain identical. Mobile layouts are additive — new responsive breakpoints and mobile-specific navigation, not rewrites.
