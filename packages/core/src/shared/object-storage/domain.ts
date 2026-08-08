import { Data } from 'effect'

export class ObjectKey extends Data.Class<{
  key: string
}> {}

export class UploadObject extends Data.Class<{
  key: string
  access?: string
}> {}

export class PresignedObjectUrl extends Data.Class<{
  key: string
  url: string
}> {}

export class TemporaryCredentialsRequest extends Data.Class<{
  userId: string
}> {}

export class TemporaryCredentials extends Data.Class<{
  endpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
  expiration: number
}> {}

export class ObjectContent extends Data.Class<{
  key: string
  body: Buffer
}> {}

export class ObjectRemoved extends Data.Class<{
  key: string
}> {}
