export interface ModelOption {
  id: string;
  label: string;
}

export interface UserSettings {
  preferredModel: string;
  streamingEnabled: boolean;
}

export interface UserSettingsResponse extends UserSettings {
  models: ModelOption[];
}

export interface UpdateUserSettingsRequest {
  preferredModel?: string;
  streamingEnabled?: boolean;
}
