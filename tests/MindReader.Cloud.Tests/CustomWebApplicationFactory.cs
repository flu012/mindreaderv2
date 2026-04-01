using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using MindReader.Cloud.Application.Common.Interfaces;
using MindReader.Cloud.Infrastructure.Data;

namespace MindReader.Cloud.Tests;

public class CustomWebApplicationFactory : WebApplicationFactory<Program>
{
    private readonly string _dbName = "TestDb_" + Guid.NewGuid().ToString("N");

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        // Use "Testing" environment to skip MigrateAsync() which is only called in Development
        builder.UseEnvironment("Testing");

        builder.ConfigureServices(services =>
        {
            // Remove ALL DbContext-related registrations
            var descriptorsToRemove = services
                .Where(d =>
                    d.ServiceType == typeof(DbContextOptions<CloudDbContext>) ||
                    d.ServiceType == typeof(DbContextOptions) ||
                    (d.ServiceType.IsGenericType &&
                     d.ServiceType.GetGenericTypeDefinition() == typeof(DbContextOptions<>)))
                .ToList();
            foreach (var d in descriptorsToRemove)
                services.Remove(d);

            // Also remove the CloudDbContext and ICloudDbContext registrations
            var contextDescriptors = services
                .Where(d =>
                    d.ServiceType == typeof(CloudDbContext) ||
                    d.ServiceType == typeof(ICloudDbContext))
                .ToList();
            foreach (var d in contextDescriptors)
                services.Remove(d);

            // Re-add with InMemory
            services.AddDbContext<CloudDbContext>(options =>
            {
                options.UseInMemoryDatabase(_dbName);
            });

            services.AddScoped<ICloudDbContext>(provider =>
                provider.GetRequiredService<CloudDbContext>());
        });
    }
}
