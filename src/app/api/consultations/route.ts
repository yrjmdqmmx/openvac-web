import {
  handleCreateConsultation,
  handleListConsultations
} from "@/server/api/consultations";

export async function GET(request: Request): Promise<Response> {
  return handleListConsultations(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleCreateConsultation(request);
}
