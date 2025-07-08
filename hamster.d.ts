declare module "hamster" {
  interface TimeRange {
    start: string;
    end: string | null;
  }

  export interface Fact {
    activity: string;
    category: string;
    description: string;
    tags: any[];
    id: number;
    activity_id: number;
    range: TimeRange;
  }
}
