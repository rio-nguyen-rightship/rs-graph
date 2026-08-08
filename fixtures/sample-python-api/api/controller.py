from domain.greeter import IGreeter


class GreetingController:
    def __init__(self, greeter: IGreeter):
        self.greeter = greeter

    def get(self, name: str) -> str:
        return self.greeter.greet(name)
