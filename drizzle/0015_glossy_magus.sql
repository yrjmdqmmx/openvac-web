ALTER TABLE "chat_attachment" DROP CONSTRAINT "chat_attachment_parse_attempts_valid";--> statement-breakpoint
ALTER TABLE "chat_attachment" ADD COLUMN "parse_poll_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_attachment" ADD COLUMN "parse_submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_attachment" ADD CONSTRAINT "chat_attachment_parse_attempts_valid" CHECK ("chat_attachment"."parse_attempts" >= 0 and "chat_attachment"."parse_max_attempts" > 0 and "chat_attachment"."parse_poll_count" >= 0);