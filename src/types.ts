export interface FetchedData {
  platform: string;
  authorName?: string | null;
  authorHandle?: string | null;
  authorAvatar?: string | null;
  title?: string | null;
  content?: string | null;
  images: string[];
  originalUrl: string;
}

export interface ChannelConfig {
  channelId: string;
  guildId: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}
