CREATE TABLE "circumference_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"guide_text" text NOT NULL,
	"sort_order" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "composition_measurements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"point_id" uuid NOT NULL,
	"value_cm" double precision NOT NULL,
	"recorded_unit" text DEFAULT 'cm' NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "composition_measurements" ADD CONSTRAINT "composition_measurements_session_id_body_composition_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."body_composition_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composition_measurements" ADD CONSTRAINT "composition_measurements_point_id_circumference_points_id_fk" FOREIGN KEY ("point_id") REFERENCES "public"."circumference_points"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "circumference_points_code_unique" ON "circumference_points" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "composition_measurements_session_point_unique" ON "composition_measurements" USING btree ("session_id","point_id");--> statement-breakpoint
CREATE INDEX "composition_measurements_point_captured" ON "composition_measurements" USING btree ("point_id","captured_at");
--> statement-breakpoint
-- Measure points are reference data, not athlete data: the same rows for
-- everyone, and the table means nothing without them. Seeded here so a fresh
-- database is immediately usable and every environment agrees on the ids.
-- `code` matches what the app already renders; ON CONFLICT keeps a manual
-- replay of this migration harmless.
INSERT INTO "circumference_points" ("id", "code", "label", "guide_text", "sort_order") VALUES
  ('a7e1c0de-0000-4000-8000-000000000001', 'neck', 'Neck', 'Just below the larynx, tape sloping slightly down at the front.', 1),
  ('a7e1c0de-0000-4000-8000-000000000002', 'chest', 'Chest', 'Across the widest point, arms relaxed, at the end of a normal breath out.', 2),
  ('a7e1c0de-0000-4000-8000-000000000003', 'waist', 'Waist', 'At the navel, tape level all the way round, without pulling it tight.', 3),
  ('a7e1c0de-0000-4000-8000-000000000004', 'hips', 'Hips', 'Around the widest part of the glutes, feet together.', 4),
  ('a7e1c0de-0000-4000-8000-000000000005', 'left_arm', 'Left arm', 'Mid-way between shoulder and elbow, arm hanging relaxed.', 5),
  ('a7e1c0de-0000-4000-8000-000000000006', 'right_arm', 'Right arm', 'Mid-way between shoulder and elbow, arm hanging relaxed.', 6),
  ('a7e1c0de-0000-4000-8000-000000000007', 'thigh', 'Thigh', 'Mid-way between hip crease and knee, weight evenly on both feet.', 7)
ON CONFLICT ("code") DO NOTHING;
