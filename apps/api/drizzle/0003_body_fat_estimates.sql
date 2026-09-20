CREATE TABLE "body_fat_estimates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"method" text NOT NULL,
	"value_low" double precision NOT NULL,
	"value_high" double precision NOT NULL,
	"confidence_label" text NOT NULL,
	"service_status" text,
	"basis" text DEFAULT '' NOT NULL,
	"calculation" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "body_fat_estimates" ADD CONSTRAINT "body_fat_estimates_session_id_body_composition_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."body_composition_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "body_fat_estimates_session_method_unique" ON "body_fat_estimates" USING btree ("session_id","method");--> statement-breakpoint
CREATE INDEX "body_fat_estimates_session" ON "body_fat_estimates" USING btree ("session_id");