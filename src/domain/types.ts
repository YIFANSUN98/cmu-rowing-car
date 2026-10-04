export const SCHEMA_VERSION = 1 as const;
export const ZONE = 'America/New_York' as const;
export const BOATHOUSE_ADDRESS = '300 Waterfront Dr, Pittsburgh, PA 15222';
export type TravelMode = 'mock' | 'google' | 'tomtom';
export const travelLabel = (mode: TravelMode) =>
  ({ mock: 'Mock', google: 'Google Maps', tomtom: 'TomTom' })[mode];
export interface TravelUsage {
  geocodingRequests: number;
  matrixSubmissions: number;
  matrixUnits: number;
  routingRequests: number;
  cacheHits: number;
}
export type Truth = 'true' | 'false' | 'unknown';
export interface Member {
  member_id: string;
  display_name: string;
  pickup_address: string;
  pickup_lat?: number;
  pickup_lng?: number;
  pickup_notes?: string;
}
export interface Attendance {
  date: string;
  member_id: string;
  attending: Truth;
  transport_mode: 'carpool' | 'self' | 'external' | 'uber' | 'unknown';
  pickup_override?: string;
  ready_after?: string;
  notes?: string;
}
export interface Availability {
  date: string;
  member_id: string;
  available: Truth;
  total_seats?: number;
  source: 'confirmed' | 'simulated';
  start_address?: string;
  earliest_departure?: string;
  max_route_minutes?: number;
}
export interface ScenarioConfig {
  seed: number;
  kind: string;
  candidateIds: string[];
  cancelledDriver?: string;
  people?: number;
  driverCount?: number;
  uploadedTest?: {
    version: 1;
    assumptions: {
      memberId: string;
      date?: string;
      field: string;
      original: string;
      assumed: string;
    }[];
  };
}
export interface Dataset {
  schemaVersion: 1;
  members: Member[];
  attendance: Attendance[];
  availability: Availability[];
  scenario?: ScenarioConfig;
}
export interface Issue {
  file: string;
  inputKind?: 'members' | 'attendance' | 'availability';
  memberId?: string;
  memberName?: string;
  row?: number;
  field?: string;
  message: string;
  severity: 'error' | 'warning';
  date?: string;
}
export interface Settings {
  comparisonDates?: Record<string, string>;
  uberFallback?: boolean;
  dates: string[];
  destination: string;
  destinationConfirmed: boolean;
  timezone: typeof ZONE;
  deadline: string;
  bufferMinutes: number;
  boardingSeconds: number;
  earliestDeparture: string;
  maxRouteMinutes: number;
  fairnessAllowance: number;
  seed: number;
  subsetLimit: number;
  evaluationBudget: number;
  beamWidth: number;
  mode: TravelMode;
}
export const defaultSettings: Settings = {
  dates: [],
  destination: BOATHOUSE_ADDRESS,
  destinationConfirmed: false,
  timezone: ZONE,
  deadline: '05:15',
  bufferMinutes: 0,
  boardingSeconds: 60,
  earliestDeparture: '04:00',
  maxRouteMinutes: 60,
  fairnessAllowance: 0.1,
  seed: 42,
  subsetLimit: 64,
  evaluationBudget: 80000,
  beamWidth: 96,
  mode: 'mock',
};
export interface Location {
  key: string;
  address: string;
  lat?: number;
  lng?: number;
}
export interface Edge {
  seconds: number;
  meters: number;
  reachable: boolean;
}
export interface Matrix {
  locations: Location[];
  edges: Edge[][];
  date: string;
  departureIso: string;
  provider: TravelMode;
}
export interface Rider {
  requiresUber?: boolean;
  id: string;
  location: number;
  ready: number;
}
export interface Driver {
  id: string;
  start: number;
  seats: number;
  earliest: number;
  maxSeconds: number;
}
export interface DayProblem {
  date: string;
  riders: Rider[];
  drivers: Driver[];
  destination: number;
  matrix: Matrix;
  deadline: number;
  boardingSeconds: number;
  independent: string[];
  external: string[];
  unresolved: string[];
  unknownAvailability: string[];
}
export interface Stop {
  location: number;
  memberIds: string[];
  arrival: number;
  departure: number;
  occupancy: number;
}
export interface CarRoute {
  fixedDeparture?: boolean;
  // Road shape from the same TomTom alternative used for verified timings.
  geometry?: { lat: number; lng: number }[];
  driverId: string;
  passengerIds: string[];
  start: number;
  destination: number;
  departure: number;
  arrival: number;
  stops: Stop[];
  drivingSeconds: number;
  durationSeconds: number;
  meters: number;
  seats: number;
  verifiedLegs?: Edge[];
}
export interface RideShareTrip {
  memberIds: string[];
  location: number;
  destination: number;
  pickupTime: number;
  departure: number;
  arrival: number;
  drivingSeconds: number;
  meters: number;
  reason: 'requested' | 'capacity';
  verifiedLeg?: Edge;
}
export interface DayPlan {
  rideShares?: RideShareTrip[];
  date: string;
  status: 'feasible' | 'input' | 'capacity' | 'timing' | 'search-exhausted';
  routes: CarRoute[];
  unassigned: string[];
  independent: string[];
  external: string[];
  unresolved: string[];
  messages: string[];
  alternatives: number;
  budgetExhausted: boolean;
}
export interface DriverUsage {
  id: string;
  eligibleDays: number;
  daysDriven: number;
  drivingSeconds: number;
  targetDays: number;
}
export interface Plan {
  manuallyEdited?: boolean;
  schemaVersion: 1;
  generatedAt: string;
  simulation: boolean;
  settings: Settings;
  scenario?: ScenarioConfig;
  days: DayPlan[];
  usage: DriverUsage[];
  fairnessScore: number;
  baselineDrivingSeconds: number;
  drivingSeconds: number;
  search: {
    evaluations: number;
    elapsedMs: number;
    subsetLimit: number;
    evaluationBudget: number;
    beamWidth: number;
  };
  verified: boolean;
  liveRechecked: boolean;
  travelUsage?: TravelUsage;
}
