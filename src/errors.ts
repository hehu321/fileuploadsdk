export class UploadSdkError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'UploadSdkError';
  }
}

export class CancelError extends UploadSdkError {
  constructor(message = 'Upload canceled') {
    super(message, 'CANCELED');
    this.name = 'CancelError';
  }
}

export class PauseError extends UploadSdkError {
  constructor(message = 'Upload paused') {
    super(message, 'PAUSED');
    this.name = 'PauseError';
  }
}

export class FatalRequestError extends UploadSdkError {
  constructor(
    message: string,
    public readonly httpStatus?: number,
    cause?: unknown,
  ) {
    super(message, 'FATAL_REQUEST', cause);
    this.name = 'FatalRequestError';
  }
}
