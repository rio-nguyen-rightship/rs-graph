class IGreeter:
    """Greets a named visitor."""

    def greet(self, name: str) -> str:
        raise NotImplementedError


class Greeter(IGreeter):
    def greet(self, name: str) -> str:
        return self.build_message(name)

    def build_message(self, name: str) -> str:
        return f"Hello, {name}!"
