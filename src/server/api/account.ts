import { asUserActor, authenticate, auditContext } from "./auth";
import { jsonData, withApiErrors } from "./errors";
import { apiStore } from "./store";
import type { ApiStore } from "./types";

export const handleClearConversationData = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    const user = await authenticate(request);
    const result = await store.clearConversationData(
      user.id,
      auditContext(request, asUserActor(user))
    );
    return jsonData(result);
  }
);
