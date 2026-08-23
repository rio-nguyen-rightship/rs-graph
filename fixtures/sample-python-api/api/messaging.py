"""Exercises PythonGraphBuilder's PUBLISHES/CONSUMES extraction: a call shaped like this org's
internal AzureServiceBusService.send_message wrapper, and a dispatch branch shaped like its
EnclosedMessageType-keyed message-type comparison.
"""


class ServiceBus:
    def send_message(self, environment, payload, message_type):
        pass


def publish_voyage_checklists_generated(voyage_id):
    bus = ServiceBus()
    bus.send_message("production", {"voyageId": voyage_id}, "VoyageChecklistsGeneratedMessage")


def handle_incoming_message(message_type, payload):
    if message_type == "VoyageChecklistsGeneratedMessage":
        return payload
    return None
