import { z } from "zod";

// The teacher's answer to "is this student still in the center?". Nothing about
// who the student is comes from the client: the check id names the prompt, and
// the server knows which student it was for.
export const pickupCheckAnswerSchema = z.object({ stillHere: z.boolean() }).strict();
