import type { AuthPrincipal } from '../auth/auth.types';

export interface HouseAgentScope {
  tenantId: string;
  siteId: string;
  /** Supplied only by authenticated server entry points; never from model arguments. */
  principal?: AuthPrincipal;
  /** Opaque conversation handle issued by HouseAgentPort. */
  conversationId?: string;
}

export interface HouseAgentReply {
  text: string;
  conversationId: string;
}

export interface HouseAgentPort {
  talk(scope: HouseAgentScope, text: string): Promise<HouseAgentReply>;
}

export const HOUSE_AGENT = Symbol('HOUSE_AGENT');
