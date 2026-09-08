CREATE TABLE "athlete_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"date_of_birth" date,
	"sex" text DEFAULT 'unspecified' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"units" text DEFAULT 'metric' NOT NULL,
	"zone_methodology" text DEFAULT 'hr_reserve' NOT NULL,
	"background" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"availability" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"constraints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notifications" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"max_heart_rate_bpm" integer,
	"resting_heart_rate_bpm" integer,
	"threshold_heart_rate_bpm" integer,
	"threshold_pace_seconds_per_km" real,
	"has_completed_onboarding" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"athlete_id" uuid,
	"action" text NOT NULL,
	"resource" text,
	"metadata" jsonb,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "body_measurements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"provider" text NOT NULL,
	"original_value" double precision NOT NULL,
	"normalized_value" double precision NOT NULL,
	"transformation" text,
	"measured_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canonical_workouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"type" text NOT NULL,
	"sport" text DEFAULT 'run' NOT NULL,
	"name" text,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"timezone" text NOT NULL,
	"local_date" date NOT NULL,
	"duration_seconds" integer,
	"moving_time_seconds" integer,
	"distance_meters" double precision,
	"avg_heart_rate_bpm" real,
	"max_heart_rate_bpm" real,
	"avg_pace_seconds_per_km" real,
	"elevation_gain_meters" double precision,
	"avg_cadence_spm" real,
	"avg_power_watts" real,
	"calories" real,
	"perceived_exertion" integer,
	"training_load" real,
	"load_model" text,
	"indoor" boolean,
	"temperature_celsius" real,
	"splits" jsonb,
	"samples" jsonb,
	"route" jsonb,
	"source_confidence" real DEFAULT 0.5 NOT NULL,
	"planned_workout_id" uuid,
	"analysis" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "check_ins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"date" date NOT NULL,
	"energy" integer NOT NULL,
	"soreness" integer NOT NULL,
	"stress" integer NOT NULL,
	"motivation" integer NOT NULL,
	"has_pain" boolean DEFAULT false NOT NULL,
	"pain_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coach_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"structured" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coach_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"date" date NOT NULL,
	"decision" text NOT NULL,
	"confidence" real NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"headline" text NOT NULL,
	"explanation" text NOT NULL,
	"affected_workout_id" uuid,
	"previous_plan" jsonb,
	"recommended_plan" jsonb,
	"acknowledged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coach_insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"data_points" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coach_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"observation_count" integer DEFAULT 1 NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"last_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "healthkit_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"sample_type" text NOT NULL,
	"start_date" timestamp with time zone NOT NULL,
	"end_date" timestamp with time zone,
	"value" double precision,
	"unit" text,
	"payload" jsonb NOT NULL,
	"source_name" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "planned_workouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"block_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"date" date NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"purpose" text NOT NULL,
	"target_distance_meters" double precision,
	"target_duration_seconds" integer,
	"target_rpe" integer,
	"structure" jsonb,
	"status" text DEFAULT 'planned' NOT NULL,
	"modified_from" jsonb,
	"completed_workout_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"external_user_id" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"access_token_encrypted" text,
	"refresh_token_encrypted" text,
	"token_expires_at" timestamp with time zone,
	"connected_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_sync_error" text,
	"sync_cursor" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "race_goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"name" text NOT NULL,
	"date" date NOT NULL,
	"distance_meters" double precision NOT NULL,
	"target_duration_seconds" integer,
	"priority" text DEFAULT 'A' NOT NULL,
	"status" text DEFAULT 'upcoming' NOT NULL,
	"notes" text,
	"result_duration_seconds" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "race_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"distance_meters" double precision NOT NULL,
	"duration_seconds" integer NOT NULL,
	"date" date NOT NULL,
	"source" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"date" date NOT NULL,
	"score" real NOT NULL,
	"band" text NOT NULL,
	"components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"missing_signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"data_completeness" real DEFAULT 0 NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strava_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"name" text,
	"sport_type" text,
	"start_date" timestamp with time zone NOT NULL,
	"timezone" text,
	"elapsed_time_seconds" integer,
	"moving_time_seconds" integer,
	"distance_meters" double precision,
	"total_elevation_gain_meters" double precision,
	"average_heart_rate" real,
	"max_heart_rate" real,
	"average_cadence" real,
	"average_watts" real,
	"calories" real,
	"suffer_score" real,
	"trainer" boolean,
	"summary_polyline" text,
	"splits" jsonb,
	"raw" jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_key" text NOT NULL,
	"external_user_id" text,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb,
	"records_fetched" integer DEFAULT 0 NOT NULL,
	"records_created" integer DEFAULT 0 NOT NULL,
	"records_updated" integer DEFAULT 0 NOT NULL,
	"duplicates_merged" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"goal" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"duration_weeks" integer NOT NULL,
	"order_index" integer NOT NULL,
	"weekly_distance_targets_meters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_loads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"date" date NOT NULL,
	"daily_load" real DEFAULT 0 NOT NULL,
	"acute_load" real,
	"chronic_load" real,
	"acute_chronic_ratio" real,
	"monotony" real,
	"strain" real,
	"weekly_load" real,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"name" text NOT NULL,
	"template" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"race_goal_id" uuid,
	"generation_basis" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weekly_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"week_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"review" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whoop_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"start" timestamp with time zone NOT NULL,
	"end" timestamp with time zone,
	"timezone_offset" text,
	"score_state" text,
	"strain" real,
	"average_heart_rate" real,
	"max_heart_rate" real,
	"kilojoule" real,
	"raw" jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whoop_recoveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"cycle_external_id" text NOT NULL,
	"sleep_external_id" text,
	"local_date" date NOT NULL,
	"score_state" text,
	"recovery_score" real,
	"resting_heart_rate" real,
	"hrv_rmssd_milli" real,
	"spo2_percentage" real,
	"skin_temp_celsius" real,
	"user_calibrating" boolean,
	"raw" jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whoop_sleep" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"cycle_external_id" text,
	"local_date" date NOT NULL,
	"start" timestamp with time zone NOT NULL,
	"end" timestamp with time zone NOT NULL,
	"timezone_offset" text,
	"nap" boolean DEFAULT false NOT NULL,
	"score_state" text,
	"total_in_bed_time_milli" integer,
	"total_awake_time_milli" integer,
	"total_light_sleep_time_milli" integer,
	"total_slow_wave_sleep_time_milli" integer,
	"total_rem_sleep_time_milli" integer,
	"sleep_cycle_count" integer,
	"disturbance_count" integer,
	"sleep_performance_percentage" real,
	"sleep_consistency_percentage" real,
	"sleep_efficiency_percentage" real,
	"respiratory_rate" real,
	"sleep_needed_baseline_milli" integer,
	"raw" jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whoop_workouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"start" timestamp with time zone NOT NULL,
	"end" timestamp with time zone NOT NULL,
	"timezone_offset" text,
	"sport_name" text,
	"sport_id" integer,
	"score_state" text,
	"strain" real,
	"average_heart_rate" real,
	"max_heart_rate" real,
	"kilojoule" real,
	"distance_meter" double precision,
	"altitude_gain_meter" double precision,
	"percent_recorded" real,
	"zone_durations" jsonb,
	"raw" jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workout_sources" (
	"canonical_workout_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"contributed_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workout_sources_canonical_workout_id_provider_external_id_pk" PRIMARY KEY("canonical_workout_id","provider","external_id")
);
--> statement-breakpoint
ALTER TABLE "athlete_profiles" ADD CONSTRAINT "athlete_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "body_measurements" ADD CONSTRAINT "body_measurements_athlete_id_athlete_profiles_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_workouts" ADD CONSTRAINT "canonical_workouts_athlete_id_athlete_profiles_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_athlete_id_athlete_profiles_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_conversations" ADD CONSTRAINT "coach_conversations_athlete_id_athlete_profiles_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_decisions" ADD CONSTRAINT "coach_decisions_athlete_id_athlete_profiles_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_insights" ADD CONSTRAINT "coach_insights_athlete_id_athlete_profiles_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_memory" ADD CONSTRAINT "coach_memory_athlete_id_athlete_profiles_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "healthkit_samples" ADD CONSTRAINT "healthkit_samples_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "healthkit_samples" ADD CONSTRAINT "healthkit_samples_athlete_id_athlete_profiles_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_workouts" ADD CONSTRAINT "planned_workouts_plan_id_training_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."training_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_workouts" ADD CONSTRAINT "planned_workouts_block_id_training_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."training_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_workouts" ADD CONSTRAINT "planned_workouts_athlete_id_athlete_profiles_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_athlete_id_athlete_profiles_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_goals" ADD CONSTRAINT "race_goals_athlete_id_athlete_profiles_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_results" ADD CONSTRAINT "race_results_athlete_id_athlete_profiles_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_states" ADD CONSTRAINT "recovery_states_athlete_id_athlete_profiles_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strava_activities" ADD CONSTRAINT "strava_activities_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strava_activities" ADD CONSTRAINT "strava_activities_athlete_id_athlete_profiles_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_athlete_id_athlete_profiles_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_blocks" ADD CONSTRAINT "training_blocks_plan_id_training_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."training_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_loads" ADD CONSTRAINT "training_loads_athlete_id_athlete_profiles_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_plans" ADD CONSTRAINT "training_plans_athlete_id_athlete_profiles_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_summaries" ADD CONSTRAINT "weekly_summaries_athlete_id_athlete_profiles_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whoop_cycles" ADD CONSTRAINT "whoop_cycles_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whoop_cycles" ADD CONSTRAINT "whoop_cycles_athlete_id_athlete_profiles_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whoop_recoveries" ADD CONSTRAINT "whoop_recoveries_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whoop_recoveries" ADD CONSTRAINT "whoop_recoveries_athlete_id_athlete_profiles_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whoop_sleep" ADD CONSTRAINT "whoop_sleep_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whoop_sleep" ADD CONSTRAINT "whoop_sleep_athlete_id_athlete_profiles_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whoop_workouts" ADD CONSTRAINT "whoop_workouts_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whoop_workouts" ADD CONSTRAINT "whoop_workouts_athlete_id_athlete_profiles_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_sources" ADD CONSTRAINT "workout_sources_canonical_workout_id_canonical_workouts_id_fk" FOREIGN KEY ("canonical_workout_id") REFERENCES "public"."canonical_workouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "athlete_profiles_user_unique" ON "athlete_profiles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_logs_user_created" ON "audit_logs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "body_measurements_lookup" ON "body_measurements" USING btree ("athlete_id","metric","measured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "body_measurements_unique" ON "body_measurements" USING btree ("athlete_id","metric","provider","measured_at");--> statement-breakpoint
CREATE INDEX "canonical_workouts_athlete_date" ON "canonical_workouts" USING btree ("athlete_id","local_date");--> statement-breakpoint
CREATE INDEX "canonical_workouts_athlete_start" ON "canonical_workouts" USING btree ("athlete_id","start_time");--> statement-breakpoint
CREATE UNIQUE INDEX "check_ins_athlete_date_unique" ON "check_ins" USING btree ("athlete_id","date");--> statement-breakpoint
CREATE INDEX "coach_conversations_athlete_created" ON "coach_conversations" USING btree ("athlete_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "coach_decisions_athlete_date_unique" ON "coach_decisions" USING btree ("athlete_id","date");--> statement-breakpoint
CREATE INDEX "coach_insights_athlete_created" ON "coach_insights" USING btree ("athlete_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "coach_memory_unique" ON "coach_memory" USING btree ("athlete_id","kind","key");--> statement-breakpoint
CREATE UNIQUE INDEX "healthkit_samples_external_unique" ON "healthkit_samples" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE INDEX "healthkit_samples_athlete_type_start" ON "healthkit_samples" USING btree ("athlete_id","sample_type","start_date");--> statement-breakpoint
CREATE INDEX "planned_workouts_athlete_date" ON "planned_workouts" USING btree ("athlete_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_connections_unique" ON "provider_connections" USING btree ("athlete_id","provider");--> statement-breakpoint
CREATE INDEX "race_goals_athlete_date" ON "race_goals" USING btree ("athlete_id","date");--> statement-breakpoint
CREATE INDEX "race_results_athlete_date" ON "race_results" USING btree ("athlete_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_states_athlete_date_unique" ON "recovery_states" USING btree ("athlete_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "strava_activities_external_unique" ON "strava_activities" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE INDEX "strava_activities_athlete_start" ON "strava_activities" USING btree ("athlete_id","start_date");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_events_provider_key_unique" ON "sync_events" USING btree ("provider","event_key");--> statement-breakpoint
CREATE INDEX "sync_events_status" ON "sync_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sync_jobs_status_run_after" ON "sync_jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE INDEX "training_blocks_plan_order" ON "training_blocks" USING btree ("plan_id","order_index");--> statement-breakpoint
CREATE UNIQUE INDEX "training_loads_athlete_date_unique" ON "training_loads" USING btree ("athlete_id","date");--> statement-breakpoint
CREATE INDEX "training_plans_athlete_status" ON "training_plans" USING btree ("athlete_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_summaries_unique" ON "weekly_summaries" USING btree ("athlete_id","week_start");--> statement-breakpoint
CREATE UNIQUE INDEX "whoop_cycles_external_unique" ON "whoop_cycles" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE INDEX "whoop_cycles_athlete_start" ON "whoop_cycles" USING btree ("athlete_id","start");--> statement-breakpoint
CREATE UNIQUE INDEX "whoop_recoveries_external_unique" ON "whoop_recoveries" USING btree ("connection_id","cycle_external_id");--> statement-breakpoint
CREATE INDEX "whoop_recoveries_athlete_date" ON "whoop_recoveries" USING btree ("athlete_id","local_date");--> statement-breakpoint
CREATE UNIQUE INDEX "whoop_sleep_external_unique" ON "whoop_sleep" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE INDEX "whoop_sleep_athlete_date" ON "whoop_sleep" USING btree ("athlete_id","local_date");--> statement-breakpoint
CREATE UNIQUE INDEX "whoop_workouts_external_unique" ON "whoop_workouts" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE INDEX "whoop_workouts_athlete_start" ON "whoop_workouts" USING btree ("athlete_id","start");--> statement-breakpoint
CREATE UNIQUE INDEX "workout_sources_provider_external_unique" ON "workout_sources" USING btree ("provider","external_id");