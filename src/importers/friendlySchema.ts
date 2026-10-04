import type { FileKind } from '../domain/validation';

export const inputKinds = ['members', 'attendance', 'availability'] as const;
export const inputLabels: Record<FileKind, string> = {
  members: 'Members',
  attendance: 'Attendance',
  availability: 'Drivers',
};

export const simpleHeaders: Record<FileKind, string[]> = {
  members: ['Name', 'Pickup address'],
  attendance: ['Date', 'Name', 'Attending?'],
  availability: ['Date', 'Name', 'Can drive?', 'Seats (including driver)'],
};
export const simpleFields: Record<FileKind, Record<string, string>> = {
  members: {
    Name: 'display_name',
    'Pickup address': 'pickup_address',
  },
  attendance: {
    Date: 'date',
    Name: 'member_id',
    'Attending?': 'attending',
  },
  availability: {
    Date: 'date',
    Name: 'member_id',
    'Can drive?': 'available',
    'Seats (including driver)': 'total_seats',
  },
};
export const simpleOptions = {
  attendance: ['Yes', 'No'],
  availability: ['Yes', 'No'],
};

// The row-based headers above also support older downloads. New templates use date grids.
export const DEFAULT_DRIVER_SEATS = 5;
export function templateHeaders(kind: FileKind, dates: string[]) {
  return kind === 'members' ? simpleHeaders.members : ['Name', ...dates];
}
