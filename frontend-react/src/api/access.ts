import { ApiError, READ_TIMEOUT_MS, api, jsonBody, serverError } from './client';

/** One catalogued field, exactly as `POST /access/simulate` reports it. */
export interface SimulateField {
  field: string;
  defaultVis: number;
  maxVis: number;
  when: string | null;
  visible: boolean;
}

export interface SimulateResponse {
  roles: string[];
  level: number;
  tier: string;
  privileged: boolean;
  staffUi: boolean;
  rows: Record<string, { readable: boolean; via: string | null; read: string[] }>;
  fields: { projects: SimulateField[]; documents: SimulateField[] };
  predicatesAssumedFalse: boolean;
  notes?: { sealedCompartment?: string };
}

export interface SimulateRequest {
  roles: string[];
  identityProvider?: string;
  teams?: string[];
  projectScope?: string[];
  credential?: { scope: { type: string; ids: string[] }; levels: number[] };
}

/**
 * Ask the engine about a described caller.
 *
 * A refusal is an answer too, so the engine's own message is what surfaces; only a request that
 * never came back is reported as silence.
 */
export async function simulateAccess(body: SimulateRequest): Promise<SimulateResponse> {
  try {
    return await api<SimulateResponse>('/access/simulate', {
      ...jsonBody(body),
      timeoutMs: READ_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof ApiError) {
      throw new Error(serverError(err.body) ?? `The access engine answered ${err.status}.`);
    }
    // A 2xx whose body will not parse is an answer with nothing in it, which Angular reports the
    // same way as a refusal; only silence reads as no answer at all.
    if (err instanceof SyntaxError) throw new Error('The access engine answered 200.');
    throw new Error('The access engine did not answer.');
  }
}
