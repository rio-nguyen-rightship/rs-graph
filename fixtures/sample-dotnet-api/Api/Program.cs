using SampleApi.Domain;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddScoped<IGreeter, Greeter>();

var app = builder.Build();

app.MapControllers();

app.Run();
