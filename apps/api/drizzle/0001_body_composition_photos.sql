CREATE TABLE "body_composition_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"local_date" date NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "composition_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"side" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "body_composition_sessions" ADD CONSTRAINT "body_composition_sessions_athlete_id_athlete_profiles_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composition_photos" ADD CONSTRAINT "composition_photos_session_id_body_composition_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."body_composition_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "body_composition_sessions_athlete_captured" ON "body_composition_sessions" USING btree ("athlete_id","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "composition_photos_session_side_unique" ON "composition_photos" USING btree ("session_id","side");--> statement-breakpoint
CREATE UNIQUE INDEX "composition_photos_storage_key_unique" ON "composition_photos" USING btree ("storage_key");