/** Greets a named visitor. */
export class GreeterService {
  greet(name: string): string {
    return this.buildMessage(name);
  }

  private buildMessage(name: string): string {
    return `Hello, ${name}!`;
  }
}
