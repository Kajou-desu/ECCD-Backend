# Weekly goals — feature proposal (not yet implemented)

`getChildProgress` (`src/controllers/parent.controller.js`) currently returns
`weeklyGoals: []` unconditionally, with a comment explaining why: there is no
teacher-facing UI or API anywhere to author curriculum goals for a child, so
there is nothing real to return. The frontend contract already exists —
`WeeklyGoalsCard.jsx` renders `{ id, title, progress, status }` per goal — it's
only the data source that's missing. This document proposes how to build one.

## Scope decision: class-wide goals, not per-child

ECCD SmartTrack's existing patterns (attendance sessions, materials, daily
theme) are all **classroom-wide**, authored once by a teacher and then read
by every parent for their own child. Curriculum goals for a preschool
classroom work the same way in practice — "this week we're working on fine
motor skills and counting to 10" applies to the whole session (morning or
afternoon), not to one child individually.

Recommendation: **model goals per (week, session)**, the same way
`DailyTheme` is modeled per day, rather than per student. This is
significantly simpler to author (a teacher sets it up once per week, not once
per student) and matches how these classrooms actually plan. Per-child
*progress* on each goal can still vary — see below — without the *goal
itself* needing to be per-child.

If a real need for individualized goals emerges later (e.g. an IEP-style
accommodation), that can be a separate, additive model
(`StudentGoalOverride`) without disturbing this one.

## Proposed data model

```prisma
// One row per (weekStart, session) — mirrors DailyTheme's one-row-per-day pattern.
model WeeklyGoal {
  id          Int      @id @default(autoincrement())
  weekStart   DateTime @db.Date   // Monday of the week, school-timezone
  session     Session              // morning | afternoon — reuses the existing enum
  title       String
  description String?
  category    String?              // e.g. "Motor Skills", "Numeracy" — free text, like Material.category
  createdById Int?
  createdBy   User?    @relation(fields: [createdById], references: [id], onDelete: SetNull)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  progress    StudentGoalProgress[]

  @@unique([weekStart, session, title])
  @@index([weekStart])
  @@map("weekly_goals")
}

// Per-student progress against a goal. Absence of a row = 0%/not started,
// so a goal doesn't need a row per student up front.
model StudentGoalProgress {
  id         Int        @id @default(autoincrement())
  goalId     Int
  studentId  Int
  progress   Int        @default(0) // 0-100, teacher-set
  status     String     @default("Not started") // short free-text shown under the bar
  updatedAt  DateTime   @updatedAt

  goal       WeeklyGoal @relation(fields: [goalId], references: [id], onDelete: Cascade)
  student    Student    @relation(fields: [studentId], references: [id], onDelete: Cascade)

  @@unique([goalId, studentId])
  @@map("student_goal_progress")
}
```

Why a separate progress table rather than a single `progress` field on
`WeeklyGoal`: different children in the same session genuinely progress
differently on the same goal, and the `WeeklyGoalsCard` UI already expects a
per-goal `progress`/`status` pair per *child*, not per classroom.

## Proposed API

Teacher/Admin authoring (new `weeklyGoals.routes.js`, same shape as
`materials.routes.js`):

- `GET /api/weekly-goals?week=YYYY-MM-DD&session=morning` — list this week's
  goals for a session, with each enrolled student's current progress
  (for the "grade the class" UI).
- `POST /api/weekly-goals` — create a goal `{ weekStart, session, title, description, category }`.
- `PUT /api/weekly-goals/:id` — edit a goal.
- `DELETE /api/weekly-goals/:id`.
- `PUT /api/weekly-goals/:id/progress` — upsert one student's progress:
  `{ studentId, progress, status }`. Bulk variant
  (`{ updates: [{studentId, progress, status}, ...] }`) is worth adding from
  day one, since a teacher will realistically update a whole session at once.

Parent-facing read (already-existing endpoint, just wired up):

- `getChildProgress` (`GET /api/students/:childId/progress`) — replace the
  hardcoded `weeklyGoals: []` with:
  ```js
  const goals = await prisma.weeklyGoal.findMany({
    where: { weekStart: currentWeekStart, session: student.session },
    include: { progress: { where: { studentId } } },
  });
  const weeklyGoals = goals.map((g) => ({
    id: g.id,
    title: g.title,
    progress: g.progress[0]?.progress ?? 0,
    status: g.progress[0]?.status ?? "Not started",
  }));
  ```
  `currentWeekStart` should reuse the school-timezone logic already in
  `schoolDate.js` (a `schoolWeekStart()` helper analogous to
  `schoolDateAsUtcMidnight()`, using `Intl`/ISO-week math to find the
  school-local Monday) — the same reasoning that makes "today" ambiguous
  across timezones applies to "this week".

## Authorization

Same pattern as `materials`/`attendance`: `requireRole("Teacher", "Admin")`
for all authoring endpoints; the parent-facing read stays inside the
existing `assertCanAccessStudent` check in `getChildProgress` — no new
ownership logic needed there.

## Suggested rollout order

1. Migration + `WeeklyGoal`/`StudentGoalProgress` models.
2. Teacher-side CRUD for goals themselves (no progress UI yet) — lets
   teachers start authoring immediately.
3. Wire `getChildProgress` to read real data (parents start seeing goals,
   all at 0%/"Not started").
4. Teacher-side progress-grading UI (a per-session roster with a slider or
   quick-set buttons per student, similar to how `AttendanceControls.jsx`
   already presents "the whole class, one row per student").

Steps 1–3 alone already remove the biggest gap (parents currently see
nothing at all); step 4 is the part that requires new teacher-facing screens
and is reasonable to schedule separately.
