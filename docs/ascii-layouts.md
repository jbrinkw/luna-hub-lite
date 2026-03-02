# ASCII Layout Examples

## Luna Hub

### Desktop Layout (Side Navigation)

```
+------------------+----------------------------------------------------------+
| LUNA HUB    [o]  |  Account                              Last synced: 2m ago |
|                  +----------------------------------------------------------+
|  > Account       |                                                          |
|    Apps          |  Profile                                                 |
|    Tools         |  +----------------------------------------------------+  |
|    Extensions    |  | Display Name   [ Jeremy              ]             |  |
|    MCP Settings  |  | Email          jeremy@example.com    (verified)    |  |
|                  |  | Timezone       [ America/Chicago     v]            |  |
|                  |  | Day Start Hour [ 6 AM                v]            |  |
|                  |  +----------------------------------------------------+  |
|                  |  [ Save Changes ]                                        |
|                  |                                                          |
|                  |  Security                                                |
|                  |  +----------------------------------------------------+  |
|                  |  | [ Change Password ]    [ Manage Sessions ]         |  |
|                  |  +----------------------------------------------------+  |
|                  |                                                          |
+------------------+----------------------------------------------------------+

[o] = offline indicator (hidden when online)
```

### Hub > Apps Page

```
+------------------+----------------------------------------------------------+
| LUNA HUB         |  Apps                                                    |
|                  +----------------------------------------------------------+
|    Account       |                                                          |
|  > Apps          |  +------------------------+  +------------------------+  |
|    Tools         |  | COACHBYTE         [ON] |  | CHEFBYTE          [ON] |  |
|    Extensions    |  | Strength training      |  | Nutrition tracking     |  |
|    MCP Settings  |  | copilot                |  | & meal planning        |  |
|                  |  |                        |  |                        |  |
|                  |  | [ Deactivate ]         |  | [ Deactivate ]         |  |
|                  |  +------------------------+  +------------------------+  |
|                  |                                                          |
|                  |  Deactivation deletes all user data in that module.      |
|                  |                                                          |
+------------------+----------------------------------------------------------+
```

### Hub > Tools Page

```
+------------------+----------------------------------------------------------+
| LUNA HUB         |  Tools                                                   |
|                  +----------------------------------------------------------+
|    Account       |                                                          |
|    Apps          |  +--------------------------------------------------+    |
|  > Tools         |  | Tool                        | Source    | Enable |    |
|    Extensions    |  |-----------------------------+-----------+--------|    |
|    MCP Settings  |  | COACHBYTE_get_today_plan    | CoachByte | [x]    |    |
|                  |  | COACHBYTE_complete_next_set  | CoachByte | [x]    |    |
|                  |  | COACHBYTE_log_set            | CoachByte | [x]    |    |
|                  |  | COACHBYTE_update_plan        | CoachByte | [x]    |    |
|                  |  | COACHBYTE_get_history         | CoachByte | [x]    |    |
|                  |  | COACHBYTE_get_split           | CoachByte | [x]    |    |
|                  |  | COACHBYTE_set_timer           | CoachByte | [x]    |    |
|                  |  | CHEFBYTE_mark_done            | ChefByte  | [x]    |    |
|                  |  | ...                           | ...       | ...    |    |
|                  |  +--------------------------------------------------+    |
|                  |                                                          |
+------------------+----------------------------------------------------------+
```

### Hub > Extensions Page

```
+------------------+----------------------------------------------------------+
| LUNA HUB         |  Extensions                                              |
|                  +----------------------------------------------------------+
|    Account       |                                                          |
|    Apps          |  +--------------------------------------------------+    |
|  > Extensions    |  | OBSIDIAN                                  [OFF]  |    |
|    Tools         |  | Note-taking integration                          |    |
|    MCP Settings  |  | API Key: [ not configured       ] [ Save ]       |    |
|                  |  +--------------------------------------------------+    |
|                  |                                                          |
|                  |  +--------------------------------------------------+    |
|                  |  | TODOIST                                    [ON]  |    |
|                  |  | Task management integration                      |    |
|                  |  | API Key: [ ********            ] [ Save ]        |    |
|                  |  +--------------------------------------------------+    |
|                  |                                                          |
|                  |  +--------------------------------------------------+    |
|                  |  | HOME ASSISTANT                            [OFF]  |    |
|                  |  | Smart home integration                           |    |
|                  |  | URL:     [ not configured       ]                |    |
|                  |  | Token:   [ not configured       ] [ Save ]       |    |
|                  |  +--------------------------------------------------+    |
|                  |                                                          |
+------------------+----------------------------------------------------------+
```

### Hub > MCP Settings Page

```
+------------------+----------------------------------------------------------+
| LUNA HUB         |  MCP Settings                                            |
|                  +----------------------------------------------------------+
|    Account       |                                                          |
|    Apps          |  Connection Details                                      |
|    Tools         |  +----------------------------------------------------+  |
|  > Extensions    |  | Endpoint   https://mcp.lunahub.dev/sse             |  |
|    MCP Settings  |  | Transport  SSE                                     |  |
|                  |  +----------------------------------------------------+  |
|                  |                                                          |
|                  |  API Keys                                                |
|                  |  +----------------------------------------------------+  |
|                  |  | Name            | Created     | Actions             |  |
|                  |  |-----------------+-------------+---------------------|  |
|                  |  | Claude Desktop  | 2025-12-01  | [ Revoke ]          |  |
|                  |  | Cursor          | 2025-12-15  | [ Revoke ]          |  |
|                  |  +----------------------------------------------------+  |
|                  |  [ + Generate New Key ]                                   |
|                  |                                                          |
|                  |  OAuth 2.1 Clients                                       |
|                  |  +----------------------------------------------------+  |
|                  |  | Client Name  | Client ID      | Actions             |  |
|                  |  |--------------+----------------+---------------------|  |
|                  |  | (none)       |                |                     |  |
|                  |  +----------------------------------------------------+  |
|                  |  [ + Register Client ]                                    |
|                  |                                                          |
+------------------+----------------------------------------------------------+
```

---

## CoachByte

### Desktop Layout — Today's Workout

```
+------------------------------------------------------------------+
| COACHBYTE   Today  History  Split  PRs  Settings            [o]  |
+------------------------------------------------------------------+
|                                                                  |
|  TODAY'S WORKOUT                              Mon Jan 13         |
|                                                                  |
|  +------------------------------------------------------------+ |
|  | NEXT IN QUEUE                                    1:47 rest  | |
|  |                                                             | |
|  |  Bench Press    5 x 225 lb                                  | |
|  |                                                             | |
|  |  Reps: [ 5  ]   Load: [ 225 ] lb                           | |
|  |                                                             | |
|  |  [ Complete Set ]   [ Pause ]   [ + Ad-Hoc Set ]           | |
|  +------------------------------------------------------------+ |
|                                                                  |
|  +----------------------------+  +----------------------------+  |
|  | SET QUEUE                  |  | COMPLETED SETS             |  |
|  |                            |  |                            |  |
|  | # Exercise    Reps Load   |  | # Exercise    Reps Load   |  |
|  | -------------------------  |  | -------------------------  |  |
|  | 3 Bench Press 5    225 lb |  | 1 Bench Press 5    225 lb |  |
|  |   >> NEXT UP              |  | 2 Bench Press 5    225 lb |  |
|  | 4 Bench Press 5    225 lb |  |                            |  |
|  | 5 Bench Press 5    225 lb |  |                            |  |
|  | 6 OHP         5    135 lb |  |                            |  |
|  | 7 OHP         5    135 lb |  |                            |  |
|  | 8 OHP         5    135 lb |  |                            |  |
|  | 9 Lat Raise   12   25 lb  |  |                            |  |
|  | 10 Lat Raise  12   25 lb  |  |                            |  |
|  | 11 Lat Raise  12   25 lb  |  |                            |  |
|  +----------------------------+  +----------------------------+  |
|                                                                  |
|  Summary: [ session notes...                                ]    |
|                                                                  |
+------------------------------------------------------------------+

[o] = offline indicator (hidden when online)
```

### CoachByte — Today's Workout with Relative Loads

```
+------------------------------------------------------------------+
| COACHBYTE   Today  History  Split  PRs  Settings                 |
+------------------------------------------------------------------+
|                                                                  |
|  TODAY'S WORKOUT                              Wed Jan 15         |
|                                                                  |
|  +------------------------------------------------------------+ |
|  | NEXT IN QUEUE                              Timer expired    | |
|  |                                                             | |
|  |  Squat    5 x 315 lb   (85% of 371)                        | |
|  |                                                             | |
|  |  Reps: [ 5  ]   Load: [ 315 ] lb                           | |
|  |                                                             | |
|  |  [ Complete Set ]   [ Start 3:00 ]   [ Custom Timer ]      | |
|  +------------------------------------------------------------+ |
|                                                                  |
|  +----------------------------+  +----------------------------+  |
|  | SET QUEUE                  |  | COMPLETED SETS             |  |
|  |                            |  |                            |  |
|  | # Exercise  Reps Load     |  | # Exercise  Reps Load     |  |
|  | -------------------------  |  | -------------------------  |  |
|  | 2 Squat     5    315 lb   |  | 1 Squat     5    315 lb   |  |
|  |   (85% of 371)            |  |                            |  |
|  |   >> NEXT UP              |  |                            |  |
|  | 3 Squat     5    315 lb   |  |                            |  |
|  |   (85% of 371)            |  |                            |  |
|  | 4 RDL       8    —        |  |                            |  |
|  |   (70% of ???) No PR      |  |                            |  |
|  +----------------------------+  +----------------------------+  |
|                                                                  |
+------------------------------------------------------------------+
```

### CoachByte — Weekly Split Planner

```
+------------------------------------------------------------------+
| COACHBYTE   Today  History  Split  PRs  Settings                 |
+------------------------------------------------------------------+
|                                                                  |
|  WEEKLY SPLIT PLANNER                                            |
|                                                                  |
|  SUNDAY — Rest                                                   |
|  (no exercises)                                                  |
|                                                                  |
|  MONDAY — Push                                                   |
|  +------------------------------------------------------------+ |
|  | Exercise     | Reps | Load    | Rel% | Rest  | Order       | |
|  |--------------+------+---------+------+-------+-------------| |
|  | Bench Press  | 5    | 85%     | [x]  | 3:00  | 1           | |
|  | OHP          | 8    | 70%     | [x]  | 2:00  | 2           | |
|  | Tri Pushdown | 12   | 60 lb   | [ ]  | 1:00  | 3           | |
|  +------------------------------------------------------------+ |
|  [ + Add Exercise ]                                              |
|                                                                  |
|  TUESDAY — Pull                                                  |
|  +------------------------------------------------------------+ |
|  | Exercise     | Reps | Load    | Rel% | Rest  | Order       | |
|  |--------------+------+---------+------+-------+-------------| |
|  | Barbell Row  | 5    | 185 lb  | [ ]  | 3:00  | 1           | |
|  | Curl         | 10   | 40 lb   | [ ]  | 1:30  | 2           | |
|  | Face Pull    | 15   | 30 lb   | [ ]  | 1:00  | 3           | |
|  +------------------------------------------------------------+ |
|  [ + Add Exercise ]                                              |
|                                                                  |
|  ... (remaining days follow same pattern)                        |
|                                                                  |
|  Split Notes: [ Push/Pull/Legs 2x — deload week 4         ]     |
|                                                                  |
+------------------------------------------------------------------+
```

### CoachByte — PR Tracker

```
+------------------------------------------------------------------+
| COACHBYTE   Today  History  Split  PRs  Settings                 |
+------------------------------------------------------------------+
|                                                                  |
|  PR TRACKER                                                      |
|                                                                  |
|  +------------------------------------------------------------+ |
|  | BENCH PRESS                                       e1RM: 261 | |
|  |                                                             | |
|  |  [1 rep: 245 lb] [3 rep: 235 lb] [5 rep: 225 lb]          | |
|  |  [8 rep: 205 lb]                                           | |
|  +------------------------------------------------------------+ |
|                                                                  |
|  +------------------------------------------------------------+ |
|  | SQUAT                                             e1RM: 366 | |
|  |                                                             | |
|  |  [1 rep: 345 lb] [3 rep: 325 lb] [5 rep: 315 lb]          | |
|  +------------------------------------------------------------+ |
|                                                                  |
|  +------------------------------------------------------------+ |
|  | DEADLIFT                                          e1RM: 399 | |
|  |                                                             | |
|  |  [3 rep: 365 lb] [5 rep: 345 lb]                           | |
|  +------------------------------------------------------------+ |
|                                                                  |
|  Tracked Exercises                                               |
|  +------------------------------------------------------------+ |
|  | [ Enter exercise name...    ] [ Add ]                       | |
|  |                                                             | |
|  | (Bench Press x) (Squat x) (Deadlift x) (OHP x) (Row x)    | |
|  +------------------------------------------------------------+ |
|                                                                  |
|  NEW PR! Deadlift 3x365 = 399 lb e1RM (prev: 388 lb)          |
|  ^^^ toast notification                                         |
|                                                                  |
+------------------------------------------------------------------+
```

### CoachByte — History

```
+------------------------------------------------------------------+
| COACHBYTE   Today  History  Split  PRs  Settings                 |
+------------------------------------------------------------------+
|                                                                  |
|  HISTORY                                  Filter: [ All      v]  |
|                                                                  |
|  +------------------------------------------------------------+ |
|  | Date          | Summary                       | Sets       | |
|  |---------------+-------------------------------+------------| |
|  | Mon Jan 13    | Push day — felt strong         | 11/11 [>] | |
|  | Sat Jan 11    | Legs — cut short, knee pain   | 6/9   [>] | |
|  | Fri Jan 10    | Pull day                       | 11/11 [>] | |
|  | Wed Jan 8     | Legs                           | 9/9   [>] | |
|  | ...                                                        | |
|  +------------------------------------------------------------+ |
|                                                                  |
|  [ Load More ]  (keyset pagination)                              |
|                                                                  |
+------------------------------------------------------------------+

[>] opens day detail view (same layout as Today's Workout, read-only for past days)
```

### CoachByte — Settings

```
+------------------------------------------------------------------+
| COACHBYTE   Today  History  Split  PRs  Settings                 |
+------------------------------------------------------------------+
|                                                                  |
|  SETTINGS                                                        |
|                                                                  |
|  Defaults                                                        |
|  +------------------------------------------------------------+ |
|  | Default Rest Duration   [ 3:00   ]                         | |
|  +------------------------------------------------------------+ |
|                                                                  |
|  Plate Calculator                                                |
|  +------------------------------------------------------------+ |
|  | Bar Weight      [ 45  ] lb                                 | |
|  | Available Plates:                                          | |
|  | [x] 45 lb  [x] 25 lb  [x] 10 lb  [x] 5 lb  [x] 2.5 lb  | |
|  +------------------------------------------------------------+ |
|                                                                  |
|  Exercise Library                                                |
|  +------------------------------------------------------------+ |
|  | Search: [ ______________ ]                                 | |
|  | Bench Press        (global)                                | |
|  | Squat              (global)                                | |
|  | My Custom Lift     (custom)    [ Delete ]                  | |
|  | ...                                                        | |
|  +------------------------------------------------------------+ |
|  [ + Add Custom Exercise ]                                       |
|                                                                  |
+------------------------------------------------------------------+
```

### CoachByte — Offline State

```
+------------------------------------------------------------------+
| COACHBYTE   Today  History  Split  PRs  Settings  !! NO CONN !!  |
+------------------------------------------------------------------+
|                                                                  |
|  TODAY'S WORKOUT                              Mon Jan 13         |
|                                                                  |
|  +------------------------------------------------------------+ |
|  | NEXT IN QUEUE                                               | |
|  |                                                             | |
|  |  Bench Press    5 x 225 lb                                  | |
|  |                                                             | |
|  |  [ Complete Set ] (DISABLED)   [ + Ad-Hoc Set ] (DISABLED)  | |
|  +------------------------------------------------------------+ |
|                                                                  |
|  All write actions disabled until connection is restored.        |
|                                                                  |
+------------------------------------------------------------------+
```

---

## ChefByte

### Desktop Layout — Dashboard

```
+------+--------------------------------------------------------------------------+
| NAV  |  DASHBOARD                                           Last synced: 1m ago |
|      +--------------------------------------------------------------------------+
|      |                                                                          |
| [>D] |  +---------------------+  +---------------------+  +-------------------+|
| [S]  |  | MISSING PRICES   3  |  | PLACEHOLDERS     2  |  | BELOW MIN STK  5 ||
| [R]  |  | Products need       |  | Items need real      |  | Restock needed   ||
| [M]  |  | price entry         |  | products linked      |  |                  ||
| [P]  |  +---------------------+  +---------------------+  +-------------------+|
| [L]  |  +------------------------------------------------------+               |
| [I]  |  | SHOPPING CART VALUE          $147.32  (23 items)      |               |
|      |  +------------------------------------------------------+               |
| D =  |                                                                          |
| Dash |  Today (6:00 AM - 5:59 AM)                                              |
| S =  |  +------------------------------------------------------------------+    |
| Scan |  | +------------+ +------------+ +------------+ +------------+     |    |
| R =  |  | | Calories   | | Carbs      | | Fats       | | Protein    |     |    |
| Rcpe |  | | 1640/900/  | | 165/200/   | | 58/60/     | | 142/120/   |     |    |
| M =  |  | | 2400       | | 280        | | 85         | | 180        |     |    |
| Meal |  | | cons/plan/ | | cons/plan/ | | cons/plan/ | | cons/plan/ |     |    |
| P =  |  | | goal       | | goal       | | goal       | | goal       |     |    |
| Shop |  | +------------+ +------------+ +------------+ +------------+     |    |
| L =  |  +------------------------------------------------------------------+    |
| Liqd |                                                                          |
| I =  |  Status: Missing Links:12 | Missing Prices:8 | Placeholder:5            |
| Inv  |          Below Min:3 | Cart Value:$147.32                                |
|      |                                                                          |
|      |  Actions:                                                                |
|      |  [ Open Shopping Links ] [ Import Shopping List ] [ Meal Plan -> Cart ]  |
|      |  [ Taste Profile ]       [ Target Macros ]        [ Liquid Tracking ]    |
|      |                                                                          |
|      |  Today's Meal Prep                                                       |
|      |  +------------------------------------------------------------------+    |
|      |  | Chicken Stir Fry     [Recipe]  2 containers  $12.99        [x]  |    |
|      |  | 450 cal  45p  35c  12f                                          |    |
|      |  +------------------------------------------------------------------+    |
|      |                                                                          |
+------+--------------------------------------------------------------------------+
```

### ChefByte — Scanner (Purchase Mode — with queue)

```
+------+----------------------------------+----------------------------------------------+
| NAV  |  QUEUE                           |  KEYPAD                                      |
|      +----------------------------------+----------------------------------------------+
|      |                                  |  Mode:                                       |
| [D]  |  Barcode: [________________]     |  [Consume+Macros] [*Purchase*] [Consume-NoMacros] [Shop] |
| [>S] |                                  |                                              |
| [R]  |  [All] [New]                     |  Active: Kirkland Greek Yogurt               |
| [M]  |                                  |  Screen: [ 2 ]                               |
| [P]  |  +------------------------------+|                                              |
| [L]  |  | Kirkland Greek Yogurt   [x]  ||  Nutrition (purchase mode only):              |
| [I]  |  | Purchased: 2 containers      ||  [Srvg/Ctn: 6] [Cal: 130] [C: 8] [F: 4] [P: 15]
|      |  | 6 srvg/ctn                   ||                                              |
|      |  | Cal:130 C:8 F:4 P:15  [edit] ||  [7] [8] [9]                                 |
|      |  | Stock: 2.00        (active)  ||  [4] [5] [6]                                 |
|      |  +------------------------------+|  [1] [2] [3]                                 |
|      |  | KIND Protein Bar   [!NEW][x] ||  [.] [0] [<-]                                |
|      |  | Purchased: 1 container       ||                                              |
|      |  | 1 srvg/ctn                   ||  [Servings / Containers toggle]               |
|      |  | Cal:250 C:30 F:10 P:12      ||                                              |
|      |  | Stock: 1.00           (red)  ||                                              |
|      |  +------------------------------+|                                              |
|      |  | Whole Milk             [x]   ||                                              |
|      |  | Purchased: 1 container       ||                                              |
|      |  | Stock: 2.00                  ||                                              |
|      |  +------------------------------+|                                              |
|      |                                  |                                              |
+------+----------------------------------+----------------------------------------------+

Queue items:
- Red border + [!NEW] badge = newly created product (needs review)
- Blue outline = currently selected/active item
- Green border = successful transaction
- [x] = delete/undo button (click once = "Confirm?", second click = undo)
- Clicking a queue item selects it — keypad edits that item's quantity
- Keypad edits debounce-save after 1 second
```

### ChefByte — Scanner (Consume Mode)

```
+------+----------------------------------+----------------------------------------------+
| NAV  |  QUEUE                           |  KEYPAD                                      |
|      +----------------------------------+----------------------------------------------+
|      |                                  |  Mode:                                       |
| [D]  |  Barcode: [________________]     |  [*Consume+Macros*] [Purchase] [Consume-NoMacros] [Shop] |
| [>S] |                                  |                                              |
| [R]  |  [All] [New]                     |  Active: Kirkland Greek Yogurt               |
| [M]  |                                  |  Screen: [ 1 ]                               |
| [P]  |  +------------------------------+|                                              |
| [L]  |  | Kirkland Greek Yogurt   [x]  ||  (No nutrition editor in consume mode)        |
| [I]  |  | Consumed: 1 serving          ||                                              |
|      |  | Stock: 11.00 -> 10.83        ||  [7] [8] [9]                                 |
|      |  |                    (active)  ||  [4] [5] [6]                                 |
|      |  +------------------------------+|  [1] [2] [3]                                 |
|      |                                  |  [.] [0] [<-]                                |
|      |                                  |                                              |
|      |                                  |  [*Servings* / Containers toggle]             |
|      |                                  |                                              |
+------+----------------------------------+----------------------------------------------+

Consume modes:
- `Consume+Macros`: deducts stock and logs macros
- `Consume-NoMacros`: deducts stock only (discarded/given away)

Unit toggle (bottom of keypad):
- Enabled in both consume modes
- Switches between servings and containers
- Converts the quantity: servings = containers × servings_per_container
```

### ChefByte — Recipes

```
+------+--------------------------------------------------------------------------+
| NAV  |  RECIPES                                                                 |
|      +--------------------------------------------------------------------------+
|      |                                                                          |
| [D]  |  Filters: [ Can Be Made ] [ < 30m active ] [ High protein ]  Search: [_]|
| [S]  |                                                                          |
| [>R] |  +----------------------------+ +----------------------------+           |
| [M]  |  | Chicken Stir Fry      [+]  | | Greek Yogurt Bowl     [+] |           |
| [P]  |  | Active: 15m  Total: 25m    | | Active: 5m   Total: 5m   |           |
| [L]  |  | Per serving:               | | Per serving:              |           |
| [I]  |  |  420 cal | 38p | 32c | 14f | |  310 cal | 28p | 22c | 8f|           |
|      |  | Protein density: 91st %ile | | Protein density: 95th %ile|           |
|      |  | CAN MAKE (stock: OK)       | | CAN MAKE (stock: OK)      |           |
|      |  +----------------------------+ +----------------------------+           |
|      |                                                                          |
|      |  +----------------------------+ +----------------------------+           |
|      |  | Beef Tacos            [+]  | | Overnight Oats        [+] |           |
|      |  | Active: 20m  Total: 30m    | | Active: 5m   Total: 8h   |           |
|      |  | Per serving:               | | Per serving:              |           |
|      |  |  510 cal | 32p | 40c | 22f | |  380 cal | 18p | 48c | 12f|           |
|      |  | Protein density: 72nd %ile | | Protein density: 54th %ile|           |
|      |  | MISSING: Tortillas (plchld)| | CAN MAKE (stock: OK)      |           |
|      |  +----------------------------+ +----------------------------+           |
|      |                                                                          |
|      |  [+] = Add to Meal Plan                                                  |
|      |                                                                          |
+------+--------------------------------------------------------------------------+

Recipe Detail (side panel / modal):
+------+------------------------------------------+-------------------------------+
| NAV  |  RECIPES                                 |  Chicken Stir Fry             |
|      |                                          |                               |
|      |                                          |  Servings: 2                  |
|      |  (card grid behind)                      |                               |
|      |                                          |  Ingredients:                 |
|      |                                          |  +---------------------------+|
|      |                                          |  | Product       Qty   Unit  ||
|      |                                          |  |---------------------------||
|      |                                          |  | Chicken Brst  2    srvg   ||
|      |                                          |  | Jasmine Rice  1    ctn    ||
|      |                                          |  | Broccoli      1    srvg   ||
|      |                                          |  | Soy Sauce     0.5  srvg   ||
|      |                                          |  | Sesame Oil    0.5  srvg   ||
|      |                                          |  +---------------------------+|
|      |                                          |                               |
|      |                                          |  Total (2 srvg):              |
|      |                                          |   840 cal | 76p | 64c | 28f  |
|      |                                          |                               |
|      |                                          |  Per serving:                 |
|      |                                          |   420 cal | 38p | 32c | 14f  |
|      |                                          |                               |
|      |                                          |  Active: 15m  Total: 25m     |
|      |                                          |                               |
|      |                                          |  [ Add to Meal Plan ]         |
|      |                                          |  [ Edit Recipe ]              |
|      |                                          |                               |
+------+------------------------------------------+-------------------------------+
```

### ChefByte — Meal Plan

```
+------+--------------------------------------------------------------------------+
| NAV  |  MEAL PLAN                              < Mon Jan 13 — Sun Jan 19 >      |
|      +--------------------------------------------------------------------------+
|      |                                                                          |
| [D]  |  +--------+--------+--------+--------+--------+--------+--------+       |
| [S]  |  | MON 13 | TUE 14 | WED 15 | THU 16 | FRI 17 | SAT 18 | SUN 19|       |
| [R]  |  +--------+--------+--------+--------+--------+--------+--------+       |
| [>M] |  |        |        |        |        |        |        |        |       |
| [P]  |  | Yogurt | Oats   | Yogurt | Oats   | Yogurt | (empty)| (empty)|       |
| [L]  |  | Bowl   |        | Bowl   |        | Bowl   |        |        |       |
| [I]  |  | [done] |        |        |        |        |        |        |       |
|      |  |        |        |        |        |        |        |        |       |
|      |  | Chkn   | Beef   | Stir   | Beef   | Chkn   |        |        |       |
|      |  | Stir   | Tacos  | Fry    | Tacos  | Stir   |        |        |       |
|      |  | Fry    |        | [PREP] |        | Fry    |        |        |       |
|      |  |        |        |        |        |        |        |        |       |
|      |  | Oats   |        | Oats   |        |        |        |        |       |
|      |  | [done] |        |        |        |        |        |        |       |
|      |  |        |        |        |        |        |        |        |       |
|      |  +--------+--------+--------+--------+--------+--------+--------+       |
|      |                                                                          |
|      |  MON 13 Detail:                                                          |
|      |  +------------------------------------------------------------------+    |
|      |  | Entry            | Mode     | Status       | Actions             |    |
|      |  |------------------+----------+--------------+---------------------|    |
|      |  | Yogurt Bowl      | Regular  | DONE (11:30) | —                   |    |
|      |  | Chicken Stir Fry | Regular  | Planned      | [Mark Done] [PREP]  |    |
|      |  | Overnight Oats   | Regular  | DONE (21:00) | —                   |    |
|      |  +------------------------------------------------------------------+    |
|      |                                                                          |
|      |  [ + Add Meal ]  [ Meal Plan -> Cart ]                                   |
|      |                                                                          |
+------+--------------------------------------------------------------------------+
```

`[PREP]` opens the Execute Meal Prep confirmation modal and runs prep execution if confirmed.

### ChefByte — Meal Plan: Meal Prep Flow

```
+------+--------------------------------------------------------------------------+
| NAV  |  MEAL PLAN — EXECUTE MEAL PREP                                           |
|      +--------------------------------------------------------------------------+
|      |                                                                          |
|      |  Chicken Stir Fry — WED Jan 15 [PREP]                                   |
|      |                                                                          |
|      |  This will:                                                              |
|      |  1. Consume ingredients from stock:                                      |
|      |     +--------------------------------------------------------------+     |
|      |     | Ingredient     | Need    | Stock  | After                    |     |
|      |     |----------------+---------+--------+--------------------------|     |
|      |     | Chicken Breast | 2 srvg  | 8 srvg | 6 srvg                  |     |
|      |     | Jasmine Rice   | 1 ctn   | 3 ctn  | 2 ctn                   |     |
|      |     | Broccoli       | 1 srvg  | 4 srvg | 3 srvg                  |     |
|      |     | Soy Sauce      | 0.5 srv | 12 srv | 11.5 srv                |     |
|      |     | Sesame Oil     | 0.5 srv | 6 srvg | 5.5 srv                 |     |
|      |     +--------------------------------------------------------------+     |
|      |                                                                          |
|      |  2. Create [MEAL] lot:                                                   |
|      |     +--------------------------------------------------------------+     |
|      |     | [MEAL] Chicken Stir Fry 01-15                                |     |
|      |     | Lot Qty: 2 containers (new lot for this prep run)           |     |
|      |     | Per serving: 420 cal | 38p | 32c | 14f                      |     |
|      |     | Nutrition frozen at current recipe values                    |     |
|      |     +--------------------------------------------------------------+     |
|      |                                                                          |
|      |  3. Macro behavior: no macros logged at prep execution time.             |
|      |     Macros log only when the [MEAL] lot is later consumed.               |
|      |                                                                          |
|      |  [ Execute Meal Prep ]    [ Cancel ]                                     |
|      |                                                                          |
+------+--------------------------------------------------------------------------+
```

### ChefByte — Macro Tracking

```
+------+--------------------------------------------------------------------------+
| NAV  |  MACROS — Mon Jan 13                           < prev  today  next >     |
|      +--------------------------------------------------------------------------+
|      |                                                                          |
| [D]  |  Day Summary                                                             |
| [S]  |  +------------------------------------------------------------------+    |
| [R]  |  | Calories  ████████████████░░░░░░░░░░  1,640 / 2,400  (68%)       |    |
| [M]  |  | Protein   ██████████████████░░░░░░░░  142g / 180g    (79%)       |    |
| [>P] |  | Carbs     ████████████░░░░░░░░░░░░░░  165g / 280g    (59%)       |    |
| [L]  |  | Fats      ████████████████░░░░░░░░░░  58g / 85g      (68%)       |    |
| [I]  |  +------------------------------------------------------------------+    |
|      |                                                                          |
|      |  Consumed Items                                                          |
|      |  +------------------------------------------------------------------+    |
|      |  | Source       | Item                | Cal  | P    | C    | F     |    |
|      |  |--------------+---------------------+------+------+------+-------|    |
|      |  | Meal Plan    | Yogurt Bowl (done)  | 310  | 28g  | 22g  | 8g    |    |
|      |  | Meal Plan    | Overnight Oats (dn) | 380  | 18g  | 48g  | 12g   |    |
|      |  | Scanner      | Protein Bar x2      | 500  | 24g  | 60g  | 20g   |    |
|      |  | Temp Item    | Coffee w/ cream     | 80   | 2g   | 4g   | 6g    |    |
|      |  | Temp Item    | Restaurant salad    | 370  | 30g  | 15g  | 12g   |    |
|      |  |              |                     |      |      |      |       |    |
|      |  |              | TOTAL               | 1640 | 142g | 165g | 58g   |    |
|      |  +------------------------------------------------------------------+    |
|      |                                                                          |
|      |  Planned (not yet consumed)                                              |
|      |  +------------------------------------------------------------------+    |
|      |  | Chicken Stir Fry         | 420  | 38g  | 32g  | 14g  | planned |    |
|      |  +------------------------------------------------------------------+    |
|      |                                                                          |
|      |  [ + Log Temp Item ]    [ Edit Targets ]    [ Taste Profile ]            |
|      |                                                                          |
+------+--------------------------------------------------------------------------+
```

### ChefByte — Macro Tracking: Target Editor & Temp Item

```
Target Macros Editor (modal):
+------------------------------------------+
|  TARGET MACROS                           |
|                                          |
|  Protein   [ 180  ] g                   |
|  Carbs     [ 280  ] g                   |
|  Fats      [ 85   ] g                   |
|                                          |
|  Calories (auto):  2,400                |
|  (carbs*4 + protein*4 + fats*9)         |
|                                          |
|  [ Save ]  [ Cancel ]                   |
+------------------------------------------+

Log Temp Item (modal):
+------------------------------------------+
|  LOG TEMP ITEM                           |
|                                          |
|  Name      [ Coffee with cream     ]    |
|  Calories  [ 80    ]                    |
|  Protein   [ 2     ] g                  |
|  Carbs     [ 4     ] g                  |
|  Fats      [ 6     ] g                  |
|                                          |
|  [ Log Item ]  [ Cancel ]               |
+------------------------------------------+

Taste Profile (modal):
+------------------------------------------+
|  TASTE PROFILE                           |
|                                          |
|  Dietary preferences and notes for       |
|  recipe filtering and AI suggestions:    |
|                                          |
|  +--------------------------------------+|
|  | High protein, moderate carbs.        ||
|  | No shellfish. Prefer chicken and     ||
|  | beef. Like Asian and Mexican         ||
|  | flavors. Meal prep friendly.         ||
|  +--------------------------------------+|
|                                          |
|  [ Save ]  [ Cancel ]                   |
+------------------------------------------+
```

### ChefByte — Shopping List

```
+------+--------------------------------------------------------------------------+
| NAV  |  SHOPPING LIST                        [ Auto-Add Below Min Stock ]       |
|      +--------------------------------------------------------------------------+
|      |                                                                          |
| [D]  |  Add Item:                                                              |
| [S]  |  [ Item name_____________ ]  [ 1 ]  [ Add ]                            |
| [R]  |                                                                          |
| [M]  |  To Buy (5)                                                             |
| [>P] |  +------------------------------------------------------------------+    |
| [L]  |  | [ ] Chicken Breast          2 containers             [ Remove ] |    |
| [I]  |  | [ ] Jasmine Rice            1 container              [ Remove ] |    |
|      |  | [ ] Broccoli Florets        2 containers             [ Remove ] |    |
|      |  | [ ] Greek Yogurt            2 containers             [ Remove ] |    |
|      |  | [ ] Protein Bars            1 container              [ Remove ] |    |
|      |  +------------------------------------------------------------------+    |
|      |                                                                          |
|      |  Purchased (2)                   [ Add Checked to Inventory ]            |
|      |  +------------------------------------------------------------------+    |
|      |  | [x] ~~Whole Milk~~          1 container              [ Remove ] |    |
|      |  | [x] ~~Soy Sauce~~           1 container              [ Remove ] |    |
|      |  +------------------------------------------------------------------+    |
|      |                                                                          |
+------+--------------------------------------------------------------------------+
```

`Add Checked to Inventory` is the same action as the Dashboard `Import Shopping List` button.

### ChefByte — Inventory

```
+------+--------------------------------------------------------------------------+
| NAV  |  INVENTORY                                        [Grouped] [Lots]      |
|      +--------------------------------------------------------------------------+
|      |                                                                          |
| [D]  |  +------------------------------------------------------------------+    |
| [S]  |  | Product           | Total Stock  | Near Exp  | Lots | Actions    |    |
| [R]  |  |-------------------+--------------+-----------+------+------------|    |
| [M]  |  | Chicken Breast    | [4.00 ctn]   | 2026-03-08| 2    | Ctn [+/-]  |    |
| [P]  |  |   012345678901    | (green)      |           |      | Srv [+/-]  |    |
| [L]  |  |   4 srvg/ctn      |              |           |      | [Consume All]|
| [>I] |  |-------------------+--------------+-----------+------+------------|    |
|      |  | Broccoli Florets  | [1.00 ctn]   | 2026-03-03| 1    | Ctn [+/-]  |    |
|      |  |   098765432101    | (orange)     |           |      | Srv [+/-]  |    |
|      |  |   4 srvg/ctn      |              |           |      | [Consume All]|
|      |  |-------------------+--------------+-----------+------+------------|    |
|      |  | Protein Bars      | [0.00 ctn]   | —         | 0    | Ctn [+/-]  |    |
|      |  |   055555555501    | (red)        |           |      | Srv [+/-]  |    |
|      |  |   12 srvg/ctn     |              |           |      | [Consume All]|
|      |  +------------------------------------------------------------------+    |
|      |                                                                          |
|      |  Grouped view is default. Toggle to Lots view shows lot_id, location,   |
|      |  qty, and expires_on rows per product.                                   |
|      |  Stock badge colors: red = 0, orange = below min, green = at/above min. |
|      |  Quantity display defaults to containers. Writes can use servings or ctn.|
|      |  Consume All = confirmation required, removes entire stock. Stock-only;  |
|      |  no macros are logged by inventory actions.                              |
|      |  Mobile: card layout with same grouped/lots toggle.                      |
|      |                                                                          |
+------+--------------------------------------------------------------------------+
```

### ChefByte — Walmart Price Manager

```
+------+--------------------------------------------------------------------------+
| NAV  |  WALMART PRICE MANAGER                                                   |
|      +--------------------------------------------------------------------------+
|      |                                                                          |
|      |  Missing Walmart Links (3 products)                                      |
|      |  +------------------------------------------------------------------+    |
|      |  | Product            | Walmart Search Results                     |    |
|      |  |--------------------+--------------------------------------------|    |
|      |  | Sesame Oil         | ( ) Kadoya Sesame Oil 5.5oz — $4.28       |    |
|      |  |                    | ( ) Great Value Sesame Oil 12oz — $3.97   |    |
|      |  |                    | (o) La Tourangelle Sesame 8oz — $6.47     |    |
|      |  |                    | ( ) Not on Walmart                        |    |
|      |  |                    | [ Link Selected ]                         |    |
|      |  |--------------------+--------------------------------------------|    |
|      |  | Fancy Mustard      | ( ) Grey Poupon 8oz — $3.98               |    |
|      |  |                    | ( ) French's Dijon 12oz — $2.97           |    |
|      |  |                    | ( ) Not on Walmart                        |    |
|      |  |                    | [ Link Selected ]                         |    |
|      |  |--------------------+--------------------------------------------|    |
|      |  | Homemade Granola   | (o) Not on Walmart                        |    |
|      |  |                    | [ Mark Not Walmart ]                      |    |
|      |  +------------------------------------------------------------------+    |
|      |                                                                          |
|      |  Missing Prices (2 products — not linked to Walmart)                     |
|      |  +------------------------------------------------------------------+    |
|      |  | Product            | Price                | Actions              |    |
|      |  |--------------------+----------------------+----------------------|    |
|      |  | Homemade Granola   | $ [ _________ ]      | [ Save Price ]       |    |
|      |  | Farmers Mkt Eggs   | $ [ _________ ]      | [ Save Price ]       |    |
|      |  +------------------------------------------------------------------+    |
|      |                                                                          |
|      |  [ Refresh All Prices ]  (manual — fetches latest from Walmart)          |
|      |                                                                          |
+------+--------------------------------------------------------------------------+
```

### ChefByte — LiquidTrack (IoT Scale)

```
+------+--------------------------------------------------------------------------+
| NAV  |  LIQUIDTRACK — Scale Devices                                             |
|      +--------------------------------------------------------------------------+
|      |                                                                          |
|      |  Registered Devices                                                      |
|      |  +------------------------------------------------------------------+    |
|      |  | Device Name    | Product         | Status   | Actions            |    |
|      |  |----------------+-----------------+----------+--------------------|    |
|      |  | Kitchen Scale  | Whole Milk      | Online   | [ Events ] [Revoke]|    |
|      |  | Coffee Scale   | Coffee Beans    | Offline  | [ Events ] [Revoke]|    |
|      |  +------------------------------------------------------------------+    |
|      |  [ + Add Device ]                                                        |
|      |                                                                          |
|      |  Add Device (expanded):                                                  |
|      |  +------------------------------------------------------------------+    |
|      |  | Device Name:  [ ________________ ]                               |    |
|      |  | Product:      [ Select product...       v]                       |    |
|      |  |                                                                  |    |
|      |  | [ Generate Device ID & Key ]                                     |    |
|      |  |                                                                  |    |
|      |  | Device ID:  lt_abc123def456  (program into ESP8266 firmware)     |    |
|      |  | Device Key: ******************************** (import step only)  |    |
|      |  +------------------------------------------------------------------+    |
|      |                                                                          |
|      |  Event Log — Kitchen Scale (Whole Milk):                                 |
|      |  +------------------------------------------------------------------+    |
|      |  | Timestamp        | Before | After  | Consumed | Macros Logged   |    |
|      |  |------------------+--------+--------+----------+-----------------|    |
|      |  | Jan 13 07:12     | 1820g  | 1580g  | 240g     | 150cal 8p 12c  |    |
|      |  | Jan 13 12:45     | 1580g  | 1340g  | 240g     | 150cal 8p 12c  |    |
|      |  | Jan 12 20:30     | 2060g  | 1820g  | 240g     | 150cal 8p 12c  |    |
|      |  | ...              |        |        |          |                 |    |
|      |  +------------------------------------------------------------------+    |
|      |                                                                          |
+------+--------------------------------------------------------------------------+
```

Provisioning/import validates the one-time device key. Runtime events use device ID + measurements only.

### ChefByte — Offline State

```
+------+--------------------------------------------------------------------------+
| NAV  |  DASHBOARD                                      !! NO CONNECTION !!      |
|      +--------------------------------------------------------------------------+
|      |                                                                          |
|      |  +---------------------+  +---------------------+  +-------------------+|
|      |  | MISSING PRICES   3  |  | PLACEHOLDERS     2  |  | BELOW MIN STK  5 ||
|      |  +---------------------+  +---------------------+  +-------------------+|
|      |                                                                          |
|      |  Macro Summary — Mon Jan 13 (stale — last synced 3m ago)                |
|      |  +------------------------------------------------------------------+    |
|      |  | Calories  ████████████████░░░░░░░░░░  1,640 / 2,400  (68%)       |    |
|      |  | Protein   ██████████████████░░░░░░░░  142g / 180g    (79%)       |    |
|      |  +------------------------------------------------------------------+    |
|      |                                                                          |
|      |  Quick Actions                                                           |
|      |  [ Import Shopping List ] (DISABLED)   [ Target Macros ] (DISABLED)      |
|      |  [ Meal Plan -> Cart ]    (DISABLED)   [ Taste Profile ] (DISABLED)      |
|      |                                                                          |
|      |  All write actions disabled until connection is restored.                 |
|      |                                                                          |
+------+--------------------------------------------------------------------------+
```
