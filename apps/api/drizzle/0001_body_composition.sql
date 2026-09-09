CREATE TABLE "body_composition_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"local_date" date NOT NULL,
	"weight_kilograms" real,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "circumference_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"guide_text" text NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "composition_measurements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"point_id" uuid NOT NULL,
	"value" double precision NOT NULL,
	"unit" text DEFAULT 'cm' NOT NULL,
	"value_cm" double precision NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "composition_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"side" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text,
	"byte_size" integer,
	"width_px" integer,
	"height_px" integer,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "body_composition_sessions" ADD CONSTRAINT "body_composition_sessions_athlete_id_athlete_profiles_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composition_measurements" ADD CONSTRAINT "composition_measurements_session_id_body_composition_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."body_composition_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composition_measurements" ADD CONSTRAINT "composition_measurements_athlete_id_athlete_profiles_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composition_measurements" ADD CONSTRAINT "composition_measurements_point_id_circumference_points_id_fk" FOREIGN KEY ("point_id") REFERENCES "public"."circumference_points"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composition_photos" ADD CONSTRAINT "composition_photos_session_id_body_composition_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."body_composition_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composition_photos" ADD CONSTRAINT "composition_photos_athlete_id_athlete_profiles_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "body_composition_sessions_athlete_captured" ON "body_composition_sessions" USING btree ("athlete_id","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "circumference_points_code_unique" ON "circumference_points" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "composition_measurements_session_point_unique" ON "composition_measurements" USING btree ("session_id","point_id");--> statement-breakpoint
CREATE INDEX "composition_measurements_athlete_point_captured" ON "composition_measurements" USING btree ("athlete_id","point_id","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "composition_photos_session_side_unique" ON "composition_photos" USING btree ("session_id","side");--> statement-breakpoint
CREATE INDEX "composition_photos_athlete_captured" ON "composition_photos" USING btree ("athlete_id","captured_at");