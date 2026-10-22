export interface HouseAgentScope {
  tenantId: string;
  siteId: string;
}

export interface HouseAgentReply {
  text: string;
  conversationId: string;
}

export interface HouseAgentPort {
  talk(scope: HouseAgentScope, text: string): Promise<HouseAgentReply>;
}

export const HOUSE_AGENT = Symbol('HOUSE_AGENT');
